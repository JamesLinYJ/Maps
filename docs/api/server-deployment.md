# Server Deployment

## Goal

Deploy this repository to a Linux server as a single-port application on port `5010`.

The production flow uses:

- FastAPI to serve both API routes and the built frontend
- a Python deployment script as the main automation entrypoint
- a thin `sh` wrapper only for convenience and Python bootstrap
- a matching uninstall script

## Resulting runtime shape

- `GET /` serves the built web app from `dist/web`
- `GET /api/runtime` and `POST /api/turn` remain unchanged
- `GET /health` remains available
- one `uvicorn` process is managed by `systemd`
- default server port is `5010`

## Scripts

- `infra/scripts/deploy.py`
- `infra/scripts/deploy.sh`
- `infra/scripts/uninstall.py`
- `infra/scripts/uninstall.sh`

## Expected server prerequisites

- Linux with `systemd`
- Node.js and npm available
- Python `3.12+` available to run the Python deployment script

If the server only has an older system Python, `infra/scripts/deploy.sh` will bootstrap a Miniforge Python runtime into `/opt/maps-bootstrap` and then invoke `deploy.py`.

The shell wrapper prints explicit phase messages and download progress so bootstrap does not look stuck during the first run.

## Example deployment command

```bash
bash infra/scripts/deploy.sh --app-dir /opt/maps --port 5010 --service-name maps
```

## Example uninstall command

```bash
bash infra/scripts/uninstall.sh --app-dir /opt/maps --service-name maps
```

## Notes

- The frontend build must exist before `uvicorn` starts in production. `deploy.py` handles this by running `npm run build:web`.
- If LLM credentials are missing, the webpage will still load, but assistant requests will return explicit provider configuration errors by design.
