# Workflow Builder

The user wants changes deployed immediately after implementation and verification.
After changing this application, run `npm run deploy`, verify the public domain
`https://wokflowbuilder.dbautoaudit.stream`, and confirm the PM2 process
`workflow-builder` is online. Keep PostgreSQL and server-data volumes intact.
The deployment script restores and saves the PM2 supervisor after deployment.
Do not leave completed changes available only in a development server.

Credential defaults: use only credentials supplied by the user for each integration.
The user-provided Google service account is the shared default for all Sheets
nodes and workflows, stored encrypted in the persistent server-data volume.
Do not replace credentials or switch accounts unless the user requests it.
Never commit credential files or print private keys/tokens.
