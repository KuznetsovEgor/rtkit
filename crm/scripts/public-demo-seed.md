# Public CRM demo seed runbook

This path is separate from `seed-synthetic-demo.mjs`, which stays restricted to the marked local loopback database. The public path adds the same fictional organizations, contacts, activity/history, tasks, draft plans, and university steps after the four synthetic public accounts already exist.

Run these commands from `crm/deploy/public-demo` on the public-demo VPS, using the private Compose network. The API must have started once and applied migrations first.

Provision the accounts through the existing one-shot Compose profile:

```sh
install -d -m 700 .private-demo-credentials
DEMO_UID="$(id -u)" DEMO_GID="$(id -g)" docker compose --env-file .env --profile provision run --rm demo-provisioner
```

The provisioner accepts only `postgres:5432/lctcrm` as `lctcrm` and `http://keycloak:8080` on the private Compose network. It sets database marker `lct CRM public_demo isolated database v1` only when the marker is absent and the CRM access/activity tables are empty. A different marker or existing access/activity data stops it without changing CRM rows. Account provisioning is still one-shot and refuses existing accounts or credential files.

## Existing VPS where the four accounts predate the marker

Do not rerun the one-shot account provisioner on an installation that already has the four accounts. Use the adoption script instead. Its dry-run is read-only and verifies the four exact enabled Keycloak accounts and their app roles, exactly matching CRM `public-demo-provisioning` rows, exactly two enabled KAM directory rows, and empty business tables. Static catalogs and migration-seeded guidance/config tables may contain their built-in rows; all other public CRM tables are checked, including unknown future tables.

The guard permits at most one pre-existing report job, and only when it is a completed `crm_portfolio` snapshot with `row_count=0`, an actor among the four verified demo accounts, no export/file metadata, no `rows` property anywhere in its JSON payload or parameters, and no associated `report_snapshot_rows`. Any other report job or any saved report rows still blocks adoption.

Preview adoption:

```sh
docker compose --env-file .env --profile provision run --rm \
  -v "$PWD/../../scripts:/app/scripts:ro" \
  --entrypoint node demo-provisioner /app/scripts/adopt-public-demo-database.mjs --dry-run
```

Apply only after the preview confirms the expected accounts and empty business tables. Both the environment opt-in and the flag are required:

```sh
docker compose --env-file .env --profile provision run --rm -e PUBLIC_DEMO_ADOPT=1 \
  -v "$PWD/../../scripts:/app/scripts:ro" \
  --entrypoint node demo-provisioner /app/scripts/adopt-public-demo-database.mjs --adopt-public-demo
```

Adoption locks and rechecks tables during apply, then writes only the public-demo database comment marker. It never creates/resets accounts, writes credentials, or changes CRM rows. If any check fails, the transaction rolls back without setting the marker. After successful adoption, run the public seed steps below.

Review the seed plan without making changes:

```sh
docker compose --env-file .env --profile provision run --rm \
  -v "$PWD/../../scripts:/app/scripts:ro" \
  --entrypoint node demo-provisioner /app/scripts/seed-public-demo.mjs --dry-run
```

Apply with both the environment opt-in and the explicit mode flag:

```sh
docker compose --env-file .env --profile provision run --rm -e PUBLIC_DEMO_SEED=1 \
  -v "$PWD/../../scripts:/app/scripts:ro" \
  --entrypoint node demo-provisioner /app/scripts/seed-public-demo.mjs --apply-public-demo
```

The seed resolves current Keycloak subjects over the private service URL and requires all four matching `public-demo-provisioning` CRM access rows. It checks the fixed database name and marker before writing. The transaction only inserts deterministic IDs with `ON CONFLICT DO NOTHING`; it skips the local seed's legacy label and subject migration steps, then verifies existing IDs against the exact fixture before commit. Conflicts trigger rollback and leave existing rows intact, so investigate them instead of forcing a rerun.

All 14 demo tasks remain open. This fixture adds no completion history, payment rows, document blobs, LMS facts, or learning-completion records. A rerun over an already seeded database inserts zero fixture rows. No migration runner is invoked by this script.

Offline validation from `crm/`:

```sh
node --test scripts/adopt-public-demo-database.test.mjs scripts/seed-public-demo.test.mjs scripts/seed-synthetic-demo.test.mjs
node scripts/seed-public-demo.mjs --dry-run
```
