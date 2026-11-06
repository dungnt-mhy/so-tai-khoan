-- Hạt giống GĐ1: chỉ metadata đã biết, KHÔNG có mật khẩu/token.
-- Chạy sau khi áp schema.sql. ID cố định để liên kết ổn định.
INSERT INTO projects (id, name, slug, description, tags, status, url, created_at, updated_at) VALUES
('p-giao-viec', 'Web App giao việc IAICT', 'web-app-giao-viec-iaict', 'Web app giao việc cho đội media, đăng bài Facebook và Instagram, chạy sau Cloudflare Tunnel trên tài khoản Cloudflare cũ', 'media,giao-viec,facebook,instagram', 'active', 'https://post.iaict-platform.com', '2026-11-06T07:00:00Z', '2026-11-06T07:00:00Z'),
('p-smartstash', 'SmartStash', 'smartstash', 'Repo bot và công cụ lưu trữ SmartStash trên GitHub, dự án code của tài khoản dungnt-mhy', 'bot,github,luu-tru', 'active', '', '2026-11-06T07:00:00Z', '2026-11-06T07:00:00Z'),
('p-so-tai-khoan', 'Sổ tài khoản', 'so-tai-khoan', 'Bot Telegram và webapp tra cứu dự án đang dùng những tài khoản nào, chạy toàn bộ trên Cloudflare tài khoản mới, độc lập hoàn toàn với tài khoản cũ', 'so-tai-khoan,cloudflare,tra-cuu', 'active', '', '2026-11-06T07:00:00Z', '2026-11-06T07:00:00Z');

INSERT INTO accounts (id, provider, provider_group, label, identity, plan, status, notes, expires_on, created_at, updated_at) VALUES
('a-github', 'GitHub', 'code', 'dungnt-mhy', 'dungnt-mhy', '', 'active', 'Tài khoản GitHub chính, tên hiển thị Ntdung', NULL, '2026-11-06T07:00:00Z', '2026-11-06T07:00:00Z'),
('a-cf-cu', 'Cloudflare', 'infra', 'Dungnt.apps@gmail.com', 'ed307ae0fda0f624b83a6aca1c33fd27', '', 'active', 'Tài khoản Cloudflare CŨ: zone iaict-platform.com, tunnel webapp-giao-viec. Chỉ ghi trong sổ để tra cứu, hạ tầng Sổ tài khoản không dùng tài khoản này.', NULL, '2026-11-06T07:00:00Z', '2026-11-06T07:00:00Z'),
('a-cf-moi', 'Cloudflare', 'infra', 'dungnt.storage@gmail.com', 'b4b733068462ffa3b17a0941c631e0e8', '', 'active', 'Tài khoản Cloudflare MỚI: Sổ tài khoản chạy toàn bộ trên tài khoản này, độc lập hoàn toàn với tài khoản cũ', NULL, '2026-11-06T07:00:00Z', '2026-11-06T07:00:00Z'),
('a-facebook', 'Facebook', 'publish', 'Nguyễn Trọng Minh Huy / Fanpage Minhy', '61595840306517', '', 'active', 'Fanpage Minhy ID Graph 1319112221296020; app IAICT Publisher đang bị chặn từ 29/10', NULL, '2026-11-06T07:00:00Z', '2026-11-06T07:00:00Z'),
('a-telegram', 'Telegram', 'other', '@iaict_media_bot', '@iaict_media_bot', '', 'active', 'Bot giao việc IAICT', NULL, '2026-11-06T07:00:00Z', '2026-11-06T07:00:00Z'),
('a-google', 'Google', 'google', 'ntdung.lak@gmail.com', 'ntdung.lak@gmail.com', '', 'active', 'Gmail và Google Drive, thư mục Giao Việc IAICT — Bản gốc', NULL, '2026-11-06T07:00:00Z', '2026-11-06T07:00:00Z');

INSERT INTO resources (id, account_id, type, name, identifier, url, notes, created_at) VALUES
('r-repo-smartstash', 'a-github', 'repo', 'SmartStash', 'dungnt-mhy/SmartStash', 'https://github.com/dungnt-mhy/SmartStash', '', '2026-11-06T07:00:00Z'),
('r-repo-webapp', 'a-github', 'repo', 'Web-giao-viec-media-iaict', 'dungnt-mhy/Web-giao-viec-media-iaict', 'https://github.com/dungnt-mhy/Web-giao-viec-media-iaict', '', '2026-11-06T07:00:00Z'),
('r-zone-iaict', 'a-cf-cu', 'zone', 'iaict-platform.com', '0c0016a34b9ad77a6eaa7f8292b0c5f2', '', 'Zone ở tài khoản cũ', '2026-11-06T07:00:00Z'),
('r-tunnel', 'a-cf-cu', 'tunnel', 'webapp-giao-viec', 'webapp-giao-viec', '', 'Trỏ post.iaict-platform.com về webapp cổng 8790', '2026-11-06T07:00:00Z'),
('r-worker-stk', 'a-cf-moi', 'worker', 'so-tai-khoan', 'so-tai-khoan', '', 'Worker Sổ tài khoản GĐ1', '2026-11-06T07:00:00Z'),
('r-d1-stk', 'a-cf-moi', 'd1', 'so-tai-khoan-db', 'so-tai-khoan-db', '', 'Database D1 của Sổ tài khoản', '2026-11-06T07:00:00Z'),
('r-r2-stk', 'a-cf-moi', 'r2', 'so-tai-khoan-backups', 'so-tai-khoan-backups', '', 'Bucket R2 backup mã hoá của Sổ tài khoản', '2026-11-06T07:00:00Z'),
('r-fanpage', 'a-facebook', 'page', 'Fanpage Minhy', '1319112221296020', 'https://www.facebook.com/61595515900524', '', '2026-11-06T07:00:00Z');

INSERT INTO project_accounts (project_id, account_id, role, note, created_at) VALUES
('p-giao-viec', 'a-github', 'code', 'Repo webapp và bot', '2026-11-06T07:00:00Z'),
('p-giao-viec', 'a-cf-cu', 'deploy', 'Tunnel + domain post.iaict-platform.com', '2026-11-06T07:00:00Z'),
('p-giao-viec', 'a-facebook', 'publish', 'Đăng Fanpage và trang cá nhân', '2026-11-06T07:00:00Z'),
('p-giao-viec', 'a-telegram', 'notify', 'Bot giao việc', '2026-11-06T07:00:00Z'),
('p-giao-viec', 'a-google', 'storage', 'Drive lưu trữ bản gốc', '2026-11-06T07:00:00Z'),
('p-smartstash', 'a-github', 'code', 'Repo chính', '2026-11-06T07:00:00Z'),
('p-so-tai-khoan', 'a-github', 'code', 'Repo so-tai-khoan', '2026-11-06T07:00:00Z'),
('p-so-tai-khoan', 'a-cf-moi', 'deploy', 'Workers + D1 + R2 toàn bộ trên tài khoản mới', '2026-11-06T07:00:00Z');
