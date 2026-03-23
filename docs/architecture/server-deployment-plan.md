# Server Deployment Plan

## Task goal

Provide a repeatable production deployment path for this repository that:

- serves the web UI and API on a single server port
- defaults the deployment port to `5010`
- uses Python deployment scripts as the primary automation entrypoint
- includes uninstall automation
- can be executed on the target server `8.140.248.249`

## Files likely to change

- `apps/backend/app/main.py`
- `apps/web/src/api-client.ts`
- `.gitignore`
- `package.json`
- `infra/scripts/deploy.py`
- `infra/scripts/uninstall.py`
- `infra/scripts/deploy.sh`
- `infra/scripts/uninstall.sh`
- `docs/architecture/server-deployment-plan.md`
- `docs/api/server-deployment.md`

## Assumptions

- The server can run `systemd`.
- The server currently has modern Node.js available.
- The server does not yet have a Python version suitable for this repo, so the deployment flow may need to bootstrap one.
- A single-port deployment is preferred over separate frontend/backend ports.

## Risks

- The server currently reports Python `3.6.8`, while this repo requires Python `>=3.12`.
- If GitHub credentials are missing on the server, cloning private repositories will fail.
- Missing LLM credentials should not block static page deployment, but live assistant requests will fail by design.

## Validation steps

- Verify the built frontend is served by FastAPI on the same port as the API.
- Run backend tests and TypeScript type checks before deployment.
- Verify `http://<server>:5010/health` returns `ok`.
- Verify `http://<server>:5010/` serves the production web app.
- Verify uninstall removes the systemd service and deployment directory cleanly.
