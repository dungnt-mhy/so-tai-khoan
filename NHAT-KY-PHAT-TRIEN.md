# Nhật ký phát triển — Sổ tài khoản

Quy ước: ghi mọi thay đổi khi xây; cuối mỗi giai đoạn hoàn thiện lại file thiết kế.

## Giai đoạn 1 — 2026-11-06 (xong, đã kiểm chứng live)

- Chốt: bot Telegram + webapp MỚI HOÀN TOÀN, chạy toàn bộ trên Cloudflare
  tài khoản MỚI (dungnt.storage@gmail.com, `b4b733068462ffa3b17a0941c631e0e8`),
  độc lập hoàn toàn với tài khoản cũ (Dungnt.apps@gmail.com). Không tunnel,
  không zone/domain/tài nguyên của tài khoản cũ.
- Hạ tầng đã tạo trên tài khoản mới:
  - Worker `so-tai-khoan` (deploy bằng API trực tiếp, xem `docs/DEPLOY.md`)
  - D1 `so-tai-khoan-db`, uuid `8f5aed90-3850-4498-b777-28f7e7396608`
  - R2 `so-tai-khoan-backups`
  - URL: https://so-tai-khoan.dungnt-storage.workers.dev
- Worker duy nhất `src/worker.js`: API + giao diện web + webhook Telegram.
  Auth PBKDF2 + session cookie HttpOnly. Bí mật chỉ lưu metadata, không lưu giá trị.
- Mô hình: Dự án (bắt buộc có mô tả để tìm kiếm) → Tài khoản nhiều-nhiều
  có vai trò (build chính/phụ, deploy, lưu trữ, đăng bài…) → Tài nguyên.
  Nhóm tài khoản AI/build riêng (Muse, GPT, Claude…).
- Tìm kiếm xuyên tên + mô tả + tag dự án, nhãn/định danh tài khoản,
  tên tài nguyên, VÀ tài khoản đã gắn vào dự án (gõ "muse" ra dự án build
  bằng Muse; gõ "cloudflare" ra 2 dự án; gõ "đăng bài facebook" ra dự án
  giao việc nhờ mô tả).
- Hạt giống: 3 dự án, 6 tài khoản, 8 tài nguyên, 8 liên kết (chỉ metadata).
- Kiểm chứng live 6/11: health 200, tạo Admin + đăng nhập, stats 3/6/8,
  CRUD dự án/tài khoản, gắn vai trò build_chinh, tìm kiếm, export JSON,
  chưa đăng nhập trả 401, đổi mật khẩu sai mật khẩu cũ trả 401,
  dữ liệu test đã dọn sạch (về lại 3/6/8).
- Bài học kỹ thuật:
  - Deploy Worker module qua API: part code PHẢI dùng
    `Content-Type: application/javascript+module`; dùng
    `application/javascript` sẽ bị lỗi 10021 `Unexpected token 'export'`.
  - workers.dev trả 403 với User-Agent mặc định của Python urllib;
    client gọi API phải gửi User-Agent dạng trình duyệt.
  - Egress proxy tới workers.dev thỉnh thoảng rớt kết nối
    (RemoteDisconnected) — gọi lại là được, và phải kiểm tra phía server
    xem lệnh đã thực hiện chưa trước khi thử lại (đã dính 2 tài khoản Muse
    test tạo trùng do thử lại mù).

## Bot Telegram — nối xong 2026-11-06

- Bot @sotaikhoanduan_bot ("Sổ tài khoản"). Token do anh gửi trong chat,
  dùng xong là xóa dấu vết: chỉ đưa vào Worker secret `TELEGRAM_BOT_TOKEN`
  + `TELEGRAM_WEBHOOK_SECRET` (secret webhook sinh ngẫu nhiên), không lưu
  giá trị token vào file, repo hay bộ nhớ.
- Webhook đã set về `https://so-tai-khoan.dungnt-storage.workers.dev/telegram/webhook`,
  getWebhookInfo xác nhận pending 0, không lỗi. Lệnh: `/tim`, `/duan`, `/taikhoan`.
- Lưu ý: lần set secret thứ 2 bị rớt kết nối (egress proxy), thử lại là được —
  xem bài học egress proxy ở cuối file GĐ1.

## Backup R2 — kiểm chứng xong 2026-11-06

- Cặp R2 API Token (Access Key ID + Secret) anh gửi trong chat, dùng xong
  là lưu mã hoá ngay ở `~/.config/so-tai-khoan/` (`r2.key` +
  `r2-credentials.enc`, AES-256-CBC + PBKDF2, 600), không lưu giá trị
  vào file thường, repo hay bộ nhớ.
- Helper S3 SigV4 tự viết (stdlib, không boto3):
  `~/workspace/custom-connectors/custom.cloudflare/bin/r2_s3.py`
  (list-buckets / list / put / get).
- Backup đầu tiên: `backups/so-tai-khoan-2026-11-06.json` trong bucket
  `so-tai-khoan-backups` (8.694 byte, 3 dự án / 6 tài khoản / 8 tài nguyên /
  8 liên kết), tải về kiểm tra SHA256 khớp đúng file gốc.
- Bài học kỹ thuật: (1) Đưa credential vào script bằng pipe openssl
  hay bị treo — giải mã ra file tạm 600 rồi redirect stdin mới ổn định.
  (2) SigV4: URI và query string phải tách riêng trong canonical request,
  và giá trị query phải URI-encode (`prefix=backups%2F`, không để `/` trần)
  nếu không sẽ SignatureDoesNotMatch.
- Token Cloudflare dạng `cfat_...` anh gửi trước đó bị trả 401 Invalid API
  Token khi gọi `/user/tokens/verify` — không dùng được, đã báo anh kiểm
  tra lại/loại token.

## Chờ (chưa làm — cần anh cấp)
- R2 API Token → backup mã hoá lên R2 (GĐ1 mới có export JSON, chưa có
  backup tự động lên R2).
- Tài khoản AI/build thật (Muse #1/#2, GPT…) — chưa có dữ liệu thật để nhập,
  đang chờ anh gửi danh sách.

## Giai đoạn 2 (dự kiến)

- Kiểm chứng sống qua API GitHub/Cloudflare, nhắc token sắp hết hạn,
  nhật ký đầy đủ trên web, backup tự động lên R2.
