# Deploy Sổ tài khoản lên Cloudflare (tài khoản mới)

Tài khoản: dungnt.storage@gmail.com, Account ID `b4b733068462ffa3b17a0941c631e0e8`.
Connector: `custom.cloudflare`, helper `~/workspace/custom-connectors/custom.cloudflare/bin/cf_deploy.py`.

## Tài nguyên đã tạo (2026-11-06)

- D1 `so-tai-khoan-db`, uuid `8f5aed90-3850-4498-b777-28f7e7396608`
- R2 `so-tai-khoan-backups`
- Worker `so-tai-khoan`

## Lệnh

```bash
ACCT=b4b733068462ffa3b17a0941c631e0e8
DB=8f5aed90-3850-4498-b777-28f7e7396608
python3 ~/workspace/custom-connectors/custom.cloudflare/bin/cf_deploy.py d1-sql-file $ACCT $DB schema.sql
python3 ~/workspace/custom-connectors/custom.cloudflare/bin/cf_deploy.py d1-sql-file $ACCT $DB seed.sql
python3 ~/workspace/custom-connectors/custom.cloudflare/bin/cf_deploy.py worker-deploy $ACCT so-tai-khoan $DB so-tai-khoan-backups src/worker.js
```

URL sau deploy: lấy từ `workers.dev` subdomain của tài khoản
(`https://dash.cloudflare.com/<account-id>/workers` → Workers & Pages → so-tai-khoan),
dạng `https://so-tai-khoan.dungnt-storage.workers.dev`.

## Bí mật Worker (cấp sau, khi có token)

```bash
python3 ~/workspace/custom-connectors/custom.cloudflare/bin/cf_deploy.py worker-secret $ACCT so-tai-khoan TELEGRAM_BOT_TOKEN <token-bot-moi>
python3 ~/workspace/custom-connectors/custom.cloudflare/bin/cf_deploy.py worker-secret $ACCT so-tai-khoan TELEGRAM_WEBHOOK_SECRET <chuoi-bi-mat-webhook>
```

Sau khi có bot token, đặt webhook:

```bash
curl "https://api.telegram.org/bot<token>/setWebhook?url=https://so-tai-khoan.dungnt-storage.workers.dev/telegram/webhook&secret_token=<chuoi-bi-mat-webhook>"
```

Không ghi token vào file, không commit vào repo.
