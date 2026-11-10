import json
import sys

data = json.load(open("outputs/probe-result.json", encoding="utf-8"))
listed = set(data.get("__tools", []))
expected = {
    "read_file", "read_text_file", "read_media_file", "read_multiple_files",
    "write_file", "edit_file", "create_directory", "list_directory",
    "list_directory_with_sizes", "directory_tree", "move_file",
    "search_files", "get_file_info", "list_allowed_directories",
}
missing = sorted(expected - listed)
if missing:
    print("missing tools:", missing)
    sys.exit(1)
print(f"all {len(expected)} tools present")
sys.exit(0)