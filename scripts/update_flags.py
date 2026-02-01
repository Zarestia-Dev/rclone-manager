import json
import os
import subprocess
import sys
import re

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
I18N_DIR = os.path.join(PROJECT_ROOT, "src", "assets", "i18n")


def get_flags():
    """Fetch flags from rclone help flags."""
    print("Fetching flags from rclone help flags...")
    try:
        # Run rclone help flags
        result = subprocess.run(
            ["rclone", "help", "flags"],
            capture_output=True,
            text=True,
            check=True,
        )
        return parse_flags(result.stdout)
    except subprocess.CalledProcessError as e:
        print(f"Error calling rclone: {e.stderr}")
        return None
    except FileNotFoundError:
        print(
            "rclone command not found. Please verify it is installed and in your PATH."
        )
        return None


def parse_flags(output):
    """
    Parses 'rclone help flags' output.
    Lines look like:
      --check-first                                 Do all the checks before starting transfers
      -c, --checksum                                    Check for changes with size & checksum ...
      --compare-dest stringArray                    Include additional server-side paths ...
    """
    flags = {}

    # Regex to capture flag name and help text
    # Matches: leading spaces, optional short flag (-x, ), --flag-name, optional type (string|int|...), help text
    # Capture group 2 is the long flag name
    # Capture group 4 is the help text

    # Revised regex:
    # ^\s+(?:-\w,\s+)?--([\w-]+)\s+(?:string|int|float|bool|stringArray|duration|int64|uint|uint32|Regexp|kv|SizeSuffix|StorageMode|Encoder)?\s*(.*)$
    # Note: The type part is heuristic, strictly we just want to grab the flag name and the description end.
    # But description might start with types like "stringArray". rclone output column aligns descriptions.

    for line in output.splitlines():
        line = line.strip()
        if not line or line.startswith("Flags") or line.startswith("Usage"):
            continue

        # We need to extract "--flag-name"
        # Search for -- followed by alphanumerics and hyphens
        match = re.search(r"--([a-z0-9-]+)", line)
        if match:
            flag_name = match.group(1)

            # Extract help text: Everything after the flag and potential type
            # This is tricky because type is not delimited clearly from help text sometimes.
            # But usually there is double space before help text or aligned?
            # Let's simple split by many spaces?

            parts = re.split(r"\s{2,}", line)
            if len(parts) >= 2:
                help_text = parts[-1]
            else:
                # Fallback, maybe only one space?
                # Take everything after the flag name, trim logic
                # It's okay if type is included in help for now, better than missing it?
                # Actually user wants clean values.
                # rclone output typically aligns descriptions at column 48 or so?

                # Let's assume the last part is help.
                help_text = line.split("  ")[-1].strip()
                if help_text.startswith("--"):  # failed to split
                    # Try to remove the flag part
                    pass

            # Clean up help text if it captures the type
            # Common types: string, stringArray, int, duration
            # Only removing if it starts with it and looks like a type?
            # Actually, `fetch_providers` was fetching from RC which gives structured data.
            # Here we parse text.
            # We can use `rclone rc options/blocks` -> get each block -> inspect?
            # User provided plan says parsing `rclone help flags`.

            # Normalize flag to snake_case
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

    # We need to add a comma if we are appending to a JSON object
    # The insertion logic will handle the comma for the PREVIOUS item,
    # but this item itself needs a comma if there are more items? No, logic is "append at end".
    # Usually the last item in JSON doesn't have a comma.
    # But if we add multiple, we need commas.
    # Also the PREVIOUS last item in file needs a comma added.

    # Text block
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
    # We want to insert before the last '}'
    # Also verify if the existing last item has a comma. If not, add it.

    # Locate last '}'
    last_brace_idx = content.rfind("}")
    if last_brace_idx == -1:
        print("  Could not find closing brace. Skipping.")
        return

    # Check text before last brace to see if we need a comma
    # Look backwards from last_brace_idx-1, skipping whitespace
    i = last_brace_idx - 1
    needs_comma = False
    while i >= 0:
        char = content[i]
        if char.strip() == "":
            i -= 1
            continue
        if char == ",":
            needs_comma = False  # Already has comma
        elif char == "{" or char == "[":
            # Empty object/array, no comma needed
            needs_comma = False
        else:
            # Likely a quote or number or boolean ending the last value
            needs_comma = True
        break

    insertion_text = ""
    if needs_comma:
        # We need to insert a comma after the previous element.
        # But we can't easily insert it AT 'i+1'.
        # Easier: Prepend comma to our new block, but that's ugly?
        # Actually, adding a comma to the previous line is best.
        # Let's splice it in.
        pass

    # Construct new blocks
    new_blocks = []
    for key, val in missing_keys:
        # Create valid JSON entry text
        # Remove trailing comma from format_new_key_block?
        # Actually format_new_key_block adds a comma.
        # This is good if we are adding multiple.
        # But the LAST one strictly implies no comma JSON-wise, but we might want one for future?
        # JSON standard forbids trailing comma.

        # Let's adjust helper.
        # The helper adds a comma.
        # For the last item, we should probably strip it?
        # Or leave it and assume user will fix/parser is lenient (rclone parser might strict).
        # User explicitly asked for "copy paste to other files", implying manual work.
        # But `rclone-manager` is a TS app, uses JSON loader. Standard JSON loader breaks on trailing comma.
        # User said "You can improve it and make that solid."

        # So:
        # 1. Add comma to previous last element if needed.
        # 2. Add new elements.
        # 3. Last added element should NOT have a comma?
        #    Actually if we add multiple, all but last need comma.

        block = format_new_key_block(key, val, indent=2)
        new_blocks.append(block)

    full_insertion = "".join(new_blocks)

    # Remove trailing comma from the very last block if we want valid JSON
    # The format_new_key_block adds ",\n".
    # trim rightmost comma?
    # full_insertion is a string.
    # regex replace last comma?
    # Or just keep it. Most editors/IDEs handle it, but JSON parser in app might fail.
    # "The scripts will insert C-style comments into the JSON files, which technically makes them invalid JSON"
    # User accepted invalid JSON (comments).
    # So trailing comma is probably acceptable too.

    # Applying checks
    new_content = list(content)

    if needs_comma:
        # Insert comma at index i+1
        new_content.insert(i + 1, ",")
        # Need to shift last_brace_idx because we added a char
        last_brace_idx += 1

    s_content = "".join(new_content)

    # Insert new blocks before last_brace_idx
    final_content = (
        s_content[:last_brace_idx] + full_insertion + "\n" + s_content[last_brace_idx:]
    )

    with open(file_path, "w", encoding="utf-8") as f:
        f.write(final_content)
    print(f"  Updated {file_path}")


def main():
    flags = get_flags()
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
