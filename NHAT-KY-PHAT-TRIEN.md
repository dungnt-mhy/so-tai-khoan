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

## Điều hướng kiểu app mobile 2026-11-06

- Anh chê thiết kế cũ chán, yêu cầu: menu ngang dưới chân; vào app là
  Thống kê; mỗi nút là một màn riêng; danh sách có thu gọn + về đầu
  trang; viền phải danh sách có thu gọn/mở rộng (10 mục); đăng xuất
  lên trên.
- Đã làm: bỏ hàng tab trên đầu, thay bằng thanh menu cố định dưới chân
  (📊 Thống kê · 📁 Dự án · 👤 Tài khoản · ➕ Thêm mới); mở app là vào
  ngay màn Thống kê; mỗi nút menu là một màn riêng (Thống kê / danh
  sách / thêm mới); nút Đăng xuất chuyển lên góc phải header, chỉ
  hiện khi đã đăng nhập; danh sách mặc định hiện 10 mục, dưới danh
  sách có dòng "Hiển thị 10/12" kèm nút "Xem thêm (2)" / "Thu gọn"
  và "⬆ Đầu trang" ở phía phải.
- Kiểm chứng: script trang thật chạy `node --check` OK; harness DOM
  giả chạy đủ 8 kiểm tra (vào app là Thống kê, chuyển màn đúng, giới
  hạn 10 → mở rộng 12 → thu gọn lại 10, nút đăng xuất hiện sau đăng
  nhập). Đã đẩy GitHub (commit 3eceba45).

## Thiết kế lại toàn bộ: bỏ tím, thêm menu Cài đặt 2026-11-06

- Anh gửi ảnh chụp: nút Xuất toàn bộ tím quá to + thanh đen bên dưới,
  yêu cầu: đổi mật khẩu cho vào menu setup; các button cân đối; hỏi
  thanh đen để làm gì; thiết kế lại toàn bộ; bỏ màu tím.
- Thanh đen là ô kết quả xuất JSON (`<pre id="exportOut">`) — để trống
  nên hiện thành thanh đen vô nghĩa. Đã sửa: ô này ẩn hẳn khi chưa
  xuất, chỉ hiện sau khi bấm Xuất; nền đổi sang sáng, không còn đen.
- Bỏ tím hoàn toàn: bảng màu mới xanh lá + xanh ngọc (emerald/teal)
  trên nền xám nhạt — header gradient xanh lá, nút xanh lá, chip/tab/
  vạch màu dự án/avatar đều đổi theo; đã quét toàn bộ trang thật,
  không còn mã màu tím nào.
- Menu Cài đặt mới (nút ⚙️ thứ 5 dưới chân): màn Thống kê chỉ còn 3 ô
  số; Đổi mật khẩu + Xuất dữ liệu chuyển hết sang màn Cài đặt.
- Button cân đối: nút lưu trong các form thêm mới và nút trong màn
  Cài đặt đều rộng bằng nhau (full chiều rộng thẻ); nút Xuất đổi
  thành nút phụ (ghost) thay vì nút to chói như trước.
- Deploy gặp sự cố: `cf_deploy.py` (urllib) kẹt 503/504 liên tiếp —
  cùng body đó deploy bằng curl lại 200 trong ~2 giây. Đã ghi bài học
  vào AGENTS.md (kiểm tra `modified_on` trước khi thử lại; đổi sang
  curl khi urllib kẹt).
- Kiểm chứng: script trang thật chạy `node --check` OK; trang thật
  không còn màu tím; harness DOM giả chạy 5 kiểm tra (vào app là
  Thống kê, sang màn Cài đặt đúng, bấm Xuất hiện ô kết quả có nội
  dung JSON, quay lại Thống kê đúng, danh sách dự án vẫn chạy).

## Màn Thống kê: căn giữa + rắn bò + ngựa phi 2026-11-06

- Anh chê màn Thống kê bên dưới trống quá, yêu cầu: cho block ra giữa;
  trên dưới làm hiệu ứng; rắn chạy ở trên block; ngựa dưới block.
- Đã làm: màn Thống kê căn giữa theo chiều dọc (flex, `min-height:
  calc(100vh - 240px)`); phía trên thẻ Thống kê là làn rắn 🐍 bò
  trườn qua lại (animation `slither`, uốn lượn lên xuống); phía dưới
  là làn ngựa 🐎 phi nước đại (animation `gallop`, nhún nhảy như
  đang phi) trên một vạch xanh nhạt làm đường chạy; cả hai lặp vô hạn.
  Tôn trọng `prefers-reduced-motion` (ai tắt chuyển động thì rắn
  ngựa đứng yên).
- Sự cố khi sửa: một lần sửa làm rớt dấu nháy khiến script lỗi cú
  pháp — Cloudflare trả 400 nên bản lỗi KHÔNG lên được, bản cũ vẫn
  chạy tốt. Bài học: luôn chạy `node --check` và DỪNG deploy nếu lỗi
  (dùng `set -e`), đừng để deploy chạy tiếp sau khi kiểm tra lỗi.
- Kiểm chứng: trang thật có đủ rắn/ngựa/animation/căn giữa, không còn
  tím; script trang thật `node --check` OK; harness chạy tốt (Thống
  kê hiện 3/6/8, Dự án và Cài đặt vẫn chạy).

## Chờ (chưa làm — cần anh cấp)
- R2 API Token → backup mã hoá lên R2 (GĐ1 mới có export JSON, chưa có
  backup tự động lên R2).
- Tài khoản AI/build thật (Muse #1/#2, GPT…) — chưa có dữ liệu thật để nhập,
  đang chờ anh gửi danh sách.

## Giai đoạn 2 (dự kiến)

- Kiểm chứng sống qua API GitHub/Cloudflare, nhắc token sắp hết hạn,
  nhật ký đầy đủ trên web, backup tự động lên R2.
