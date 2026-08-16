from flask import Flask, send_from_directory, request, jsonify
import copy
import threading

app = Flask(__name__, static_folder=".")

# In-memory store: dataset_name -> { "notes": [...], "version": int }
_store_lock = threading.Lock()
datasets = {}


# ---------------------------------------------------------------------------
# Static files
# ---------------------------------------------------------------------------

@app.route("/")
def index():
    return send_from_directory(".", "index.html")


@app.route("/<path:filename>")
def static_files(filename):
    return send_from_directory(".", filename)


# ---------------------------------------------------------------------------
# Sync API
# ---------------------------------------------------------------------------

def _note_key(note):
    """Canonical identity key for a note."""
    return (note["pitch"], note["startBeat"], note["durationBeats"])


def _merge_notes(base, incoming):
    """
    Three-way merge strategy (last-write-wins per unique slot):
    - Start with *incoming* notes as authoritative.
    - Any note in *base* whose slot is not present in *incoming* is retained.
    - Duplicate slots (same pitch + startBeat) are resolved by keeping the
      incoming version (peer push wins over server-stored version).
    Returns (merged_notes, peer_changes) where peer_changes is a list of
    notes that differ between base and the merged result.
    """
    # Index base notes by (pitch, startBeat) for fast lookup
    base_index = {(n["pitch"], n["startBeat"]): n for n in base}
    incoming_index = {(n["pitch"], n["startBeat"]): n for n in incoming}

    merged = {}

    # Keep all incoming notes (peer wins)
    for key, note in incoming_index.items():
        merged[key] = note

    # Retain base notes whose slot was not touched by incoming
    for key, note in base_index.items():
        if key not in merged:
            merged[key] = note

    merged_list = sorted(merged.values(), key=lambda n: (n["startBeat"], n["pitch"]))

    # Determine which notes are new/changed compared to base
    base_keys = set(base_index.keys())
    incoming_keys = set(incoming_index.keys())
    added_keys = incoming_keys - base_keys
    removed_keys = base_keys - incoming_keys

    peer_changes = {
        "added": [incoming_index[k] for k in added_keys],
        "removed": [base_index[k] for k in removed_keys],
    }

    return merged_list, peer_changes


@app.route("/api/sync/push", methods=["POST"])
def sync_push():
    """
    Peer pushes its local notes to the server.
    Body: { "dataset": str, "notes": [...] }
    Server merges the incoming notes with any existing stored notes.
    Returns: { "status": "merged", "notes": [...], "version": int, "peer_changes": {...} }
    """
    body = request.get_json(force=True, silent=True)
    if not body or "dataset" not in body or "notes" not in body:
        return jsonify({"error": "dataset and notes are required"}), 400

    dataset_name = body["dataset"]
    incoming_notes = body["notes"]

    if not isinstance(incoming_notes, list):
        return jsonify({"error": "notes must be a list"}), 400

    with _store_lock:
        existing = datasets.get(dataset_name, {"notes": [], "version": 0})
        merged, peer_changes = _merge_notes(existing["notes"], incoming_notes)
        new_version = existing["version"] + 1
        datasets[dataset_name] = {"notes": merged, "version": new_version}
        result = copy.deepcopy(datasets[dataset_name])

    return jsonify({
        "status": "merged",
        "dataset": dataset_name,
        "notes": result["notes"],
        "version": result["version"],
        "peer_changes": peer_changes,
    })


@app.route("/api/sync/pull", methods=["GET"])
def sync_pull():
    """
    Peer fetches the current merged dataset from the server.
    Query param: dataset=<name>
    Returns: { "status": "ok", "notes": [...], "version": int }
    """
    dataset_name = request.args.get("dataset", "")
    if not dataset_name:
        return jsonify({"error": "dataset query parameter is required"}), 400

    with _store_lock:
        existing = datasets.get(dataset_name, {"notes": [], "version": 0})
        result = copy.deepcopy(existing)

    return jsonify({
        "status": "ok",
        "dataset": dataset_name,
        "notes": result["notes"],
        "version": result["version"],
    })


@app.route("/api/sync/datasets", methods=["GET"])
def list_datasets():
    """List all dataset names currently stored on the server."""
    with _store_lock:
        names = list(datasets.keys())
    return jsonify({"datasets": names})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)
