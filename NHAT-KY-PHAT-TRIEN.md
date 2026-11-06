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

## Tự nhập liệu — thêm form gắn + tài nguyên 2026-11-06

- Anh hỏi "Tôi tự nhập được đúng không?" — lúc đó tab Thêm mới mới có
  form thêm dự án và thêm tài khoản, CHƯA có form gắn tài khoản vào dự án
  và thêm tài nguyên, nên tự nhập chưa đủ. Đã bổ sung ngay:
  - "Gắn tài khoản vào dự án": chọn dự án + tài khoản + vai trò
    (build chính/phụ, code, deploy, lưu trữ, đăng bài, thông báo) + ghi chú.
  - "Thêm tài nguyên vào tài khoản": chọn tài khoản + loại
    (repo, domain, worker, tunnel, D1, R2, fanpage, bot) + tên + định danh + link.
- Hai form dùng chung API đã kiểm chứng ở GĐ1
  (POST /api/projects/:id/accounts, POST /api/resources); danh sách chọn
  nạp từ /api/projects + /api/accounts mỗi lần mở tab Thêm mới.
- Kiểm chứng live: đăng nhập Admin vẫn dùng mật khẩu tạm được
  (anh chưa đổi — nhắc lại: đổi ngay trong webapp, mục Thống kê);
  dropdown dự án/tài khoản nạp đúng 3 dự án / 6 tài khoản; đã đẩy
  GitHub (commit b941956e).
- Bot Telegram hiện chỉ tra cứu (/tim, /duan, /taikhoan) — thêm mới
  qua bot chưa có, nếu anh cần sẽ làm ở GĐ sau.

## LỖI NẶNG: script webapp chết từ GĐ1, sửa 2026-11-06

- Anh nhắn "Không có gì đâu, kiểm tra lại" sau khi em bảo tự nhập được.
  Kiểm tra lại thì phát hiện: **toàn bộ JavaScript của webapp chưa từng
  chạy được trên trình duyệt** — trang hiện ra nhưng nút Đăng nhập,
  các tab, danh sách đều chết.
- Nguyên nhân: trong `src/worker.js`, phần `<script>` chứa các chuỗi
  HTML có dấu nháy kép lồng nhau (`onclick="viewAccount('...')"` nằm
  trong chuỗi JS dùng nháy kép) — khi Worker ráp trang, các dấu nháy
  này không còn được escape, trình duyệt đọc script tới đó là báo lỗi
  cú pháp và dừng toàn bộ script. Lỗi có từ bản GĐ1 đầu tiên.
- Vì sao không phát hiện sớm: em chỉ kiểm chứng API bằng curl
  (API chạy tốt), chưa bao giờ kiểm tra code JS mà trình duyệt nhận
  được có chạy được không. Bài học: sau mỗi lần deploy webapp, phải
  tải trang thật về, tách phần `<script>` ra và chạy `node --check`
  (hoặc chạy thử bằng harness DOM giả) — đã làm harness
  `/tmp/stk-harness.js` để kiểm tra việc này.
- Cách sửa: bỏ dấu nháy kép quanh giá trị thuộc tính HTML trong các
  chuỗi JS (`onclick=viewAccount('...')`, `<option value=...>`,
  bỏ luôn `style=...` có khoảng trắng viết sai), vì giá trị không
  chứa khoảng trắng nên HTML không cần nháy.
- Kiểm chứng sau sửa: script trang thật chạy `node --check` OK;
  harness chạy `showTab('n')` nạp đúng dropdown 3 dự án / 6 tài khoản,
  bấm gắn thử báo "Đã gắn tài khoản vào dự án."; API đăng nhập bằng
  mật khẩu tạm vẫn 200 (anh chưa đổi — nhắc lại lần nữa).
- Lưu ý khi kiểm chứng sau deploy: bản mới cần vài chục giây mới lan
  tới mọi máy chủ Cloudflare — lần đầu tải ngay sau deploy vẫn thấy
  bản cũ, tải lại sau đó mới thấy bản mới. Đừng kết luận vội.
- Phát hiện thêm khi thử gắn trùng: API gắn tài khoản chưa chặn trùng —
  gắn cùng cặp dự án–tài khoản lần 2 vẫn tạo dòng mới (đã xoá dòng
  trùng do em tạo khi thử, đếm lại đúng 8 liên kết). GĐ2 cần thêm
  UNIQUE(project_id, account_id) hoặc kiểm tra trùng trước khi chèn.

## Thiết kế lại giao diện 2026-11-06

- Anh yêu cầu: đẹp hơn, bắt mắt; phân chia rõ block/section; thêm mới
  thì hiện form nhập; phân biệt rõ giữa các dự án.
- Đã làm: header gradient tím + tiêu đề; tab dạng viên thuốc; ô tìm
  kiếm trong thẻ riêng; danh sách dạng lưới (mobile 1 cột, desktop
  2 cột); mỗi thẻ dự án có vạch màu trên cùng xoay 6 màu + nhãn trạng
  thái màu (Đang làm xanh lá / Tạm dừng vàng / Đã xong xám); thẻ tài
  khoản có ô vuông chữ cái đầu nhà cung cấp, mỗi nhóm một màu; thẻ
  chi tiết chia mục bằng tiêu đề section + dòng phân cách; Thống kê
  hiện 3 ô số lớn; form thêm mới thành 4 nút chọn (Thêm dự án /
  Thêm tài khoản / Gắn tài khoản / Thêm tài nguyên), bấm nút nào thì
  chỉ hiện form đó, mỗi form một màu viền trái riêng.
- Quy tắc rút ra từ lỗi lần trước: trong code JS của trang, thuộc tính
  HTML chỉ dùng MỘT class duy nhất không có dấu nháy (ví dụ class
  `pcard`, `bar0`, `avaai`, `chipb`, `sta`) — vì viết 2 class không
  nháy (`class=card pcard`) trình duyệt sẽ đọc sai. Màu sắc đi qua
  tên class, không đi qua `style=`.
- Kiểm chứng: script trang thật chạy `node --check` OK; harness DOM
  giả chạy đủ 8 kiểm tra (thẻ dự án có vạch màu + nhãn trạng thái,
  thẻ tài khoản có avatar màu, chi tiết có section, form thêm mới
  chuyển đúng, thống kê hiện số, gắn thử OK). Đã đẩy GitHub
  (commit 7cdfe62).
- Lưu ý: lúc sửa Thống kê em gõ thừa một dấu nháy làm script lỗi cú
  pháp — đã sửa bằng cách đếm đúng mã ký tự từng vị trí, không đoán
  bằng mắt nữa. Bài học: sau khi sửa chuỗi JS lồng nhau, luôn chạy
  kiểm tra từng hàm bằng `new Function` để bắt đúng hàm lỗi.
- Mật khẩu Admin: anh ĐÃ ĐỔI (kiểm tra lúc 15:55, mật khẩu tạm trả
  401) — từ giờ đừng dùng mật khẩu tạm nữa.

## Chờ (chưa làm — cần anh cấp)
- R2 API Token → backup mã hoá lên R2 (GĐ1 mới có export JSON, chưa có
  backup tự động lên R2).
- Tài khoản AI/build thật (Muse #1/#2, GPT…) — chưa có dữ liệu thật để nhập,
  đang chờ anh gửi danh sách.

## Giai đoạn 2 (dự kiến)

- Kiểm chứng sống qua API GitHub/Cloudflare, nhắc token sắp hết hạn,
  nhật ký đầy đủ trên web, backup tự động lên R2.
