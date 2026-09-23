"""
The Lambda entry point.

Kept to one line of substance on purpose. `app.py` is an ordinary ASGI
application that runs under uvicorn on a laptop exactly as the README says, and
Mangum is the adapter that lets the same object answer a Function URL event.
Nothing about the service's behaviour lives here, so "does it work locally" and
"does it work deployed" cannot drift apart.
"""
from __future__ import annotations

from mangum import Mangum

from app import api

# `lifespan='off'`: FastAPI's startup and shutdown events would run per cold
# start, and this application has none worth running — the model session is
# created lazily on first use and then held for the life of the container,
# which is what we want anyway.
handler = Mangum(api, lifespan='off')
