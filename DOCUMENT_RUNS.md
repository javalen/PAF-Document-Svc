# Document run endpoint

The MochaHost deployment keeps `SCHEDULER_ENABLED=false` and
`RUN_ON_STARTUP=false`. One external scheduler submits authenticated work to the
durable run queue.

## Environment

- `DOCUMENT_RUN_API_KEY`: required bearer token for run submission and status.
- `DOCUMENT_RUN_STORE_PATH`: optional durable JSON path. Defaults to
  `data/document-runs.json` under the application root.
- `DOCUMENT_RUN_POLL_MS`: optional queue polling interval; default 15000.
- `DOCUMENT_RUN_LEASE_MS`: optional worker lease; default 900000.
- `DOCUMENT_RUN_HISTORY_LIMIT`: optional retained run count; default 500.

## cron-job.org

- Method: `POST`
- URL: `https://documents.predictaf.com/document-runs`
- Header: `Authorization: Bearer DOCUMENT_RUN_API_KEY_VALUE`
- Header: `Content-Type: application/json`
- Body: `{ "source": "cron-job.org" }`

Do not set a permanent `X-Trigger-Id`; omitted IDs are generated for every
request. A successful submission returns `202 Accepted` with a run ID and an
authenticated status URL.
