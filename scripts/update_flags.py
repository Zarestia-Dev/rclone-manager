import json
import os
import subprocess
import sys
import argparse
import re

# Configuration
DEFAULT_RCLONE_URL = "http://127.0.0.1:51900"
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
I18N_DIR = os.path.join(PROJECT_ROOT, "src", "assets", "i18n")


def get_flags(url):
    """Fetch flags from rclone rc options/info."""
    print(f"Fetching flags from {url}...")
    try:
        # Run rclone rc options/info
        cmd = [
            "rclone",
            "rc",
            "options/info",
            "--rc-no-auth",
            "--url",
            url,
        ]
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            check=True,
        )
        return parse_flags(result.stdout)
    except subprocess.CalledProcessError as e:
        print(f"Error calling rclone: {e.stderr}")
        print(
            "Ensure rclone is running with 'rclone rcd --rc-no-auth --rc-addr :51900' or similar."
        )
        return None
    except FileNotFoundError:
        print(
            "rclone command not found. Please verify it is installed and in your PATH."
        )
        return None
    except Exception as e:
        print(f"Unexpected error: {e}")
        return None


def parse_flags(output):
    """
    Parses 'rclone rc options/info' output (JSON).
    Returns a dictionary of flags mapped to their help text.
    """
    try:
        data = json.loads(output)
    except json.JSONDecodeError as e:
        print(f"Error decoding JSON response: {e}")
        return {}

    flags = {}

    # data is a dict where keys are block names (e.g. "main", "mount")
    # and values are lists of option objects.
    for block_name, options in data.items():
        if not isinstance(options, list):
            continue

        for option in options:
            flag_name = option.get("Name")
            help_text = option.get("Help", "")

            if not flag_name:
                continue

            # Key is already snake_case in 'Name' field typically, but let's ensure consistency.
            # We used to do flag_name.replace("-", "_").
            # options/info 'Name' is usually snake_case (e.g. "buffer_size").
            # But let's safe guard.
            key = flag_name.replace("-", "_")

            flags[key] = {"title": title_case(flag_name), "help": help_text}

    return flags


def title_case(s):
    """Simple title case helper that converts snakey-kebaby to Title Case."""
    # split by - or _
    parts = re.split(r"[-_]", s)
    return " ".join(p.capitalize() for p in parts)


def format_new_key_block(key, value, indent=2):
    """Formats a new key/value pair with the specific comment block."""
    # Standard rclone.json is 2 space indent
    json_str = json.dumps({key: value}, indent=indent, ensure_ascii=False)
    lines = json_str.splitlines()
    if len(lines) >= 3:
        content_lines = lines[1:-1]
        content = "\n".join(content_lines)
    else:
        content = f'"{key}": {json.dumps(value, ensure_ascii=False)}'

    block = (
        f'\n{" " * indent}/////////////////////////////////////// New Key start\n'
        f"{content},\n"
        f'{" " * indent}////////////////////////////////////// New key end'
    )
    return block


def update_file(file_path, flags_data):
    """Updates a single rclone.json file."""
    print(f"Checking {file_path}...")

    try:
        with open(file_path, "r", encoding="utf-8") as f:
            content = f.read()
            current_data = json.loads(content)
    except (FileNotFoundError, json.JSONDecodeError):
        print(f"  Skipping invalid or missing file: {file_path}")
        return

    # Check for missing keys
    missing_keys = []

    for key, val in flags_data.items():
        if key not in current_data:
            missing_keys.append((key, val))

    if not missing_keys:
        print(f"  No missing keys in {file_path}")
        return

    print(f"  Found {len(missing_keys)} missing keys in {file_path}")

    # Find insertion point: the last closing brace '}'
    last_brace_idx = content.rfind("}")
    if last_brace_idx == -1:
        print("  Could not find closing brace. Skipping.")
        return

    # Check text before last brace to see if we need a comma
    i = last_brace_idx - 1
    needs_comma = False
    while i >= 0:
        char = content[i]
        if char.strip() == "":
            i -= 1
            continue
        if char == ",":
            needs_comma = False
        elif char == "{" or char == "[":
            needs_comma = False
        else:
            needs_comma = True
        break

    # Construct new blocks
    new_blocks = []
    for key, val in missing_keys:
        block = format_new_key_block(key, val, indent=2)
        new_blocks.append(block)

    full_insertion = "".join(new_blocks)

    new_content = list(content)

    if needs_comma:
        new_content.insert(i + 1, ",")
        last_brace_idx += 1

    s_content = "".join(new_content)

    final_content = (
        s_content[:last_brace_idx] + full_insertion + "\n" + s_content[last_brace_idx:]
    )

    with open(file_path, "w", encoding="utf-8") as f:
        f.write(final_content)
    print(f"  Updated {file_path}")


def main():
    parser = argparse.ArgumentParser(
        description="Update rclone.json with new flags from rclone."
    )
    parser.add_argument("--url", default=DEFAULT_RCLONE_URL, help="Rclone RC URL")
    args = parser.parse_args()

    flags = get_flags(args.url)
    if not flags:
        sys.exit(1)

    if not os.path.exists(I18N_DIR):
        print(f"i18n directory not found at {I18N_DIR}")
        sys.exit(1)

    for entry in os.listdir(I18N_DIR):
        lang_dir = os.path.join(I18N_DIR, entry)
        if os.path.isdir(lang_dir):
            target_file = os.path.join(lang_dir, "rclone.json")
            if os.path.exists(target_file):
                print(f"Processing language: {entry}")
                update_file(target_file, flags)


if __name__ == "__main__":
    main()
