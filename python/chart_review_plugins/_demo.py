# Fixture plugin — proves the plugin path end to end (Task 5). Not a real task tool.
def demo_lab(data_dir: str = "data") -> dict:
    """Demo read tool. Returns a constant so the test/agent can confirm the
    plugin was loaded and data_dir was bound."""
    return {"data_dir": data_dir, "ok": True}


def demo_patient(person_id: int, keyword: str = "", data_dir: str = "data") -> dict:
    """Demo read tool with a REQUIRED bound param, mirroring the real RUCAM
    tools (person_id has no default). Exists so the tests can check that a bound
    required param is hidden from the LLM-facing schema — otherwise the empty
    call the prompts ask for dies in validation before the bind applies."""
    return {"person_id": person_id, "keyword": keyword, "data_dir": data_dir, "ok": True}


TOOLS = [demo_lab, demo_patient]
