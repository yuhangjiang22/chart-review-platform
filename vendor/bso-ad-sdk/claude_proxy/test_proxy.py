"""
Test: use claude-code-sdk to call OpenAI/Gemini through the proxy.

Make sure proxy.py is running, then:
    OPENAI_API_KEY="sk-..." OPENAI_MODEL="gpt-5.4" python test_proxy.py
"""

import asyncio
import os


async def main():

    from claude_agent_sdk import query, ClaudeAgentOptions


    api_key = os.environ.get("OPENAI_API_KEY", "")
    model = os.environ.get("OPENAI_MODEL", "gpt-5.4")

    if not api_key:
        print("Error: OPENAI_API_KEY env var is required")
        return

    print(f"Proxy test: model={model}, proxy=http://127.0.0.1:18080")
    print()

    options = ClaudeAgentOptions(
        cwd=os.getcwd(),
        permission_mode="bypassPermissions",
        model=model,
        env={
            "ANTHROPIC_BASE_URL": "http://127.0.0.1:18080",
            "ANTHROPIC_API_KEY": api_key,
            # Pin every internal alias to the same model so proxied calls never
            # 404 on built-in haiku/opus names. ANTHROPIC_SMALL_FAST_MODEL is
            # deprecated; ANTHROPIC_DEFAULT_HAIKU_MODEL is the replacement.
            "ANTHROPIC_DEFAULT_HAIKU_MODEL": model,
            "ANTHROPIC_DEFAULT_SONNET_MODEL": model,
            "ANTHROPIC_DEFAULT_OPUS_MODEL": model,
            "CLAUDE_CODE_SUBAGENT_MODEL": model,
            "PATH": os.environ.get("PATH", ""),
        },
    )

    try:
        async for msg in query(prompt="Create a file called helloworld.py in the current directory with a hello world program. Use the Write tool to save it to disk.", options=options):
            msg_type = type(msg).__name__
            if hasattr(msg, "content"):
                print(f"  [{msg_type}] {msg.content}")
            elif hasattr(msg, "text"):
                print(f"  [{msg_type}] {msg.text}")
            else:
                print(f"  [{msg_type}] {msg}")
    except Exception as e:
        print(f"  Error: {type(e).__name__}: {e}")


if __name__ == "__main__":
    asyncio.run(main())
