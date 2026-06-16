# Fixture plugin — proves the plugin path end to end (Task 5). Not a real task tool.
def demo_lab(data_dir: str = "data") -> dict:
    """Demo read tool. Returns a constant so the test/agent can confirm the
    plugin was loaded and data_dir was bound."""
    return {"data_dir": data_dir, "ok": True}


TOOLS = [demo_lab]
