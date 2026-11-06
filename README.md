# Sổ tài khoản

Bot Telegram + Webapp tra cứu "dự án A đang dùng những tài khoản nào".

- **Chạy toàn bộ trên Cloudflare tài khoản MỚI, độc lập hoàn toàn với tài khoản cũ.**
  Tài khoản: dungnt.storage@gmail.com, Account ID `b4b733068462ffa3b17a0941c631e0e8`.
  Không dùng tunnel, không dùng zone/domain/tài nguyên của tài khoản cũ.
- **Hạ tầng:** Worker `so-tai-khoan` + D1 `so-tai-khoan-db`
  (`8f5aed90-3850-4498-b777-28f7e7396608`) + R2 `so-tai-khoan-backups`.
- **URL thử:** `https://so-tai-khoan.dungnt-storage.workers.dev` (xem `docs/DEPLOY.md` để lấy subdomain thật sau khi deploy).
- **Mô hình:** Dự án → Tài khoản (nhiều-nhiều, có vai trò: build chính/phụ, deploy, lưu trữ, đăng bài…) → Tài nguyên trong tài khoản.
  Dự án bắt buộc có mô tả để tìm kiếm theo tên + mô tả + từ khoá.
  Tài khoản build (Muse, GPT, Claude, Gemini…) là nhóm riêng, một dự án dùng được nhiều tài khoản Muse.
- **Bảo mật:** bí mật chỉ lưu metadata (loại, nơi cất, 4 ký tự cuối, hạn), không lưu giá trị.
  Telegram không bao giờ gửi nguyên văn token/mật khẩu. Chỉ Admin xem/sửa bí mật.

## Giai đoạn 1 (đang xây)

CRUD dự án / tài khoản / tài nguyên, gắn vai trò, tìm kiếm xuyên mô tả,
bot tra nhanh `/tim`, `/duan`, `/taikhoan`, webapp quản trị, xuất JSON, nhật ký.

## Cấu trúc

- `src/worker.js` — Worker duy nhất: API + giao diện web + webhook Telegram.
- `schema.sql` — schema D1. `seed.sql` — hạt giống metadata đã biết (không có bí mật).
- `wrangler.toml` — cấu hình deploy bằng wrangler (khi có token ở máy deploy).
- `docs/DEPLOY.md` — cách deploy bằng API trực tiếp qua connector `custom.cloudflare`.

## Deploy

Xem `docs/DEPLOY.md`. Không commit token, mật khẩu hay bí mật nào vào repo.
