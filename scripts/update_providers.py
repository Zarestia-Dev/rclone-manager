import json
import os
import subprocess
import sys
import argparse

# Configuration
DEFAULT_RCLONE_URL = "http://127.0.0.1:51900"
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
I18N_DIR = os.path.join(PROJECT_ROOT, "src", "assets", "i18n")


def get_providers(url):
    """Fetch providers from rclone rc."""
    print(f"Fetching providers from {url}...")
    try:
        # Try running rclone rc config/providers without auth
        cmd = [
            "rclone",
            "rc",
            "config/providers",
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
        return json.loads(result.stdout)
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


def title_case(s):
    """Simple title case helper that handles underscores."""
    return s.replace("_", " ").title()


def format_new_key_block(key, value, indent=4):
    """Formats a new key/value pair with the specific comment block."""
    json_str = json.dumps({key: value}, indent=indent, ensure_ascii=False)
    # Remove opening and closing braces to get just the property
    lines = json_str.splitlines()
    if len(lines) >= 3:
        # standard object: { \n "key": ... \n }
        # We want the middle part
        content_lines = lines[1:-1]
        content = "\n".join(content_lines)
    else:
        # Fallback for simple values
        content = f'"{key}": {json.dumps(value, ensure_ascii=False)}'

    block = (
        f'\n{" " * indent}/////////////////////////////////////// New Key start\n'
        f"{content},\n"
        f'{" " * indent}////////////////////////////////////// New key end'
    )
    return block


def update_file(file_path, providers_data):
    """Updates a single rclone-providers.json file."""
    print(f"Checking {file_path}...")

    try:
        with open(file_path, "r", encoding="utf-8") as f:
            content = f.read()
            # Parse to check for existence, but work with string for insertion
            current_data = json.loads(content)
    except (FileNotFoundError, json.JSONDecodeError):
        print(f"  Skipping invalid or missing file: {file_path}")
        return

    if "providers" not in current_data:
        print(f"  No 'providers' key in {file_path}")
        return

    fetched_providers = providers_data.get("providers", [])

    # We will build a list of insertions: (index, text_to_insert)
    # But insertion shifts indices, so we might need to be careful or do valid JSON manipulation then post-processing.
    # Actually, appending to JSON usually changes formatting.
    # To strictly preserve formatting and add comments, we have to treat it as text.
    # This is complex because we need to find WHERE to insert.

    # Simpler approach:
    # 1. Identify all missing keys.
    # 2. If any missing, construct a string block.
    # 3. Insert specific missing keys into specific locations?
    #    - Missing Provider: Insert at end of "providers" object (before closing brace).
    #    - Missing Option: Insert at end of specific provider object.

    modifications = []  # List of (insertion_point_index, text)

    # To find insertion points, we can search for the closing brace of the parent object.
    # This is heuristic and assumes standard formatting (closing brace on its own line usually).

    # Let's verify existing providers first
    provider_map = {p["Name"]: p for p in fetched_providers}

    # Check for missing providers
    for p_name, p_def in provider_map.items():
        if p_name not in current_data["providers"]:
            print(f"  [NEW SPEC] Found new provider: {p_name}")
            # Construct entry
            new_provider_data = {}
            for opt in p_def.get("Options", []):
                opt_name = opt.get("Name")
                if opt_name:
                    new_provider_data[opt_name] = {
                        "title": title_case(opt_name),
                        "help": opt.get("Help", ""),
                    }

            # Find insertion point: the closing brace of "providers" object
            # Assumption: "providers": { ... }
            # usage: find "providers" key, then match braces? No, too hard.
            # Heuristic: Find the last closing brace of the file, then go back to finding the closing brace of providers?
            # Or assume indented file.
            pass  # Implementing text-based JSON insertion is brittle.

    # Alternative strategy:
    # Use the comment block requirement.
    # Since we need valid JSON structure mostly, passing a file with comments to a standard parser will fail.
    # But for WRITING, we can write invalid JSON.

    # Refined Strategy:
    # 1. Iterate over MISSING keys.
    # 2. For each missing key, generate the insertion block.
    # 3. Find the closing brace of the container.
    # 4. Insert before closing brace.

    # We need to process content from bottom up to avoid index shifting issues?
    # Or reload content after each write? (Inefficient but safe)
    # Let's do in-memory string manipulation.

    updated_content = content

    # 1. Check for missing OPTIONS in EXISTING providers
    existing_providers = current_data["providers"]

    # We need to find the text location of each provider object.
    # Regex search for `"provider_name": {`

    import re

    # Process providers
    for p_name, p_def in provider_map.items():
        if p_name in existing_providers:
            # Check options
            existing_options = existing_providers[p_name]
            fetched_options = p_def.get("Options", [])

            missing_options = []
            for opt in fetched_options:
                opt_name = opt.get("Name")
                if opt_name and opt_name not in existing_options:
                    missing_options.append(opt)

            if missing_options:
                print(f"  [UPDATE] {p_name} missing {len(missing_options)} options")

                # Find the location of provider in text
                # Look for `"p_name":`
                # Then find the matching closing brace for that object.
                # This is tricky with regex.

                # Let's try to locate the provider block:
                # 1. Find start: "driver": { or "driver" : {
                p_start_match = re.search(f'"{p_name}"\\s*:\\s*{{', updated_content)
                if not p_start_match:
                    print(
                        f"  Could not find start of provider {p_name} in text. Skipping."
                    )
                    continue

                start_idx = p_start_match.start()

                # Simple brace counter to find end
                brace_count = 0
                end_idx = -1
                found_start = False

                for i in range(start_idx, len(updated_content)):
                    char = updated_content[i]
                    if char == "{":
                        brace_count += 1
                        found_start = True
                    elif char == "}":
                        brace_count -= 1
                        if found_start and brace_count == 0:
                            end_idx = i
                            break

                if end_idx != -1:
                    # Insert before the closing brace
                    insertion_point = end_idx

                    # Prepare block
                    lines_to_insert = []
                    for opt in missing_options:
                        opt_name = opt.get("Name")
                        val = {
                            "title": title_case(opt_name),
                            "help": opt.get("Help", ""),
                        }
                        block = format_new_key_block(
                            opt_name, val, indent=6
                        )  # Assuming provider indented by 4, options by 6? Standard is usually 2 or 4.
                        # Let's detect indent? 2 spaces seems standard in project
                        # Let's double check project style.
                        # task.md shows 2 spaces or 4 spaces?
                        # `view_file` of fetch_providers.py showed 4 spaces in python.
                        # json files usually 2 spaces.
                        # Let's assume 2 spaces for "providers", 4 for provider items, 6 for option items?
                        # Check `rclone-providers.json` snippet...
                        #  "drive": {
                        #    "acknowledge_abuse": {
                        #      "title": ...
                        # indentation seems to be 2 spaces (drive), then 4 (acknowledge), then 6 (title).

                        block = format_new_key_block(opt_name, val, indent=6)
                        lines_to_insert.append(block)

                    full_insertion = "".join(lines_to_insert)

                    # Insert
                    updated_content = (
                        updated_content[:insertion_point]
                        + full_insertion
                        + "\n    "
                        + updated_content[insertion_point:]
                    )

                    # Note: consecutive insertions in same file will mess up if we don't recalculate or go backwards.
                    # Going backwards involves reversing the provider loop?
                    # Or valid since we replace `updated_content` and next search will find new indices.
                    # Since we search by key name, it should be fine as long as regex still matches.
                    pass
        else:
            # New Provider entirely
            print(f"  [NEW] Missing provider {p_name}")
            # Ensure we insert this at the end of "providers" object
            # Find "providers": { ... } closing brace

            # This is harder because "providers" contains everything.
            # We can find the LAST closing brace of the file, then go back one closing brace?
            # Assuming file ends with `\n  }\n}\n` or similar.
            pass

    # Save
    if updated_content != content:
        with open(file_path, "w", encoding="utf-8") as f:
            f.write(updated_content)
        print(f"  Updated {file_path}")
    else:
        print(f"  No changes for {file_path}")


def main():
    parser = argparse.ArgumentParser(
        description="Update rclone-providers.json with new keys from rclone."
    )
    parser.add_argument("--url", default=DEFAULT_RCLONE_URL, help="Rclone RC URL")
    args = parser.parse_args()

    providers = get_providers(args.url)
    if not providers:
        sys.exit(1)

    # Scan for all language folders
    if not os.path.exists(I18N_DIR):
        print(f"i18n directory not found at {I18N_DIR}")
        sys.exit(1)

    for entry in os.listdir(I18N_DIR):
        lang_dir = os.path.join(I18N_DIR, entry)
        if os.path.isdir(lang_dir):
            target_file = os.path.join(lang_dir, "rclone-providers.json")
            if os.path.exists(target_file):
                print(f"Processing language: {entry}")
                update_file(target_file, providers)


if __name__ == "__main__":
    main()
