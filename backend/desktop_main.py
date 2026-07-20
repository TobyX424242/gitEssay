"""PyInstaller build entry (see desktop.spec). For running from source use
`uv run python -m app.desktop` instead."""
from app.desktop import main

if __name__ == "__main__":
    main()
