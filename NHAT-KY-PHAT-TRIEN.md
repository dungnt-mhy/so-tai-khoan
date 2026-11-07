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

## Rắn ngựa to hơn + nền trang chọn/tải lên + thẻ Thống kê có màu 2026-11-06

- Anh yêu cầu: cho rắn ngựa to ra; set nền cho trang; trong Cài đặt
  cho chọn hoặc tải ảnh lên làm nền; block Thống kê cũng có màu nền.
- Rắn ngựa to gần gấp đôi (30px → 54px), biên độ uốn/nhún tăng theo
  (rắn ±10px, ngựa nhún 18px).
- Thẻ Thống kê giờ có màu nền: gradient xanh lá → xanh ngọc, chữ
  trắng; 3 ô số thành ô trắng mờ trên nền xanh.
- Nền trang mới trong menu Cài đặt ("🖼️ Nền trang"): 5 nút tròn chọn
  nhanh — Mặc định (xám nhạt), Xanh lá, Xanh dương, Hoàng hôn, Đêm
  (tối); nút đang chọn có viền xanh lá. Thêm ô tải ảnh lên: chọn ảnh
  từ máy, tự thu nhỏ tối đa 1280px + nén JPEG 0.8 rồi lưu làm nền
  (ảnh quá lớn thì báo lỗi, không lưu). Lựa chọn lưu trong
  localStorage của trình duyệt (`stk_bg`) nên mở lại vẫn giữ; lưu ý
  là lưu theo từng trình duyệt/thiết bị, đổi máy khác phải chọn lại.
- Kiểm chứng: trang thật có đủ các thành phần mới; script trang thật
  `node --check` OK; harness 7 kiểm tra đạt (mặc định → xanh lá →
  đêm → về mặc định, nền ảnh `cover/fixed`, màn Cài đặt và Thống kê
  chuyển qua lại bình thường).

## Tiêu đề xanh + nhà cung cấp kiểu note + gạch đầu dòng chỉ đậm nhãn 2026-11-06

- Anh gửi 3 ảnh chụp, yêu cầu: chữ Cloudflare cho kiểu note (giống
  trạng thái); các tiêu đề như "giao việc..." cho chữ xanh (blue);
  các gạch đầu dòng như "repo" thì chỉ in đậm các chữ đấy, không đậm
  cả câu.
- Đã làm: tiêu đề dự án (cả ở danh sách lẫn màn chi tiết) thành màu
  xanh dương `#0284c7`; chữ nhà cung cấp (Cloudflare...) thành viên
  tròn kiểu trạng thái — nền xanh nhạt, chữ xanh đậm (class `.note`,
  cùng dáng với các nhãn trạng thái Đang làm/Tạm dừng); các gạch đầu
  dòng tài nguyên (`· d1: ...`, `· r2: ...`, `· repo: ...`) giờ chỉ
  in đậm đúng nhãn (`d1:`, `r2:`, `repo:`), tên và mã sau đó để chữ
  thường. Tiêu đề tài khoản (email/label) giữ nguyên màu tối.
- Bài học thoát ký tự: nội dung tool trả về (JSON) hiển thị `\"`
  nhưng trong file thật chỉ là `"` thường — chuỗi trong worker.js
  dùng nháy đơn nên `"` không cần escape; lần sửa đầu vì tin theo
  `\"` nên khớp 0, phải sửa lại dùng `"` thường mới khớp.
- Kiểm chứng: trang thật có đủ `.ptitle`, `.note`, `<b>` nhãn;
  script trang thật `node --check` OK; harness 6 kiểm tra đạt
  (danh sách + chi tiết dự án/tài khoản đều đúng).

## Tên tài khoản xanh + trạng thái cùng dòng với tên dự án 2026-11-06

- Anh yêu cầu: tên tài khoản cho màu tím hoặc xanh; trạng thái "Đang
  làm" cho ngang với tên dự án (cùng dòng).
- Đã làm: tên tài khoản (email/label) thành màu xanh dương `#0284c7`
  — em chọn xanh thay vì tím để giữ đúng ý anh dặn trước là bỏ tím
  hoàn toàn, đồng thời đồng bộ với tiêu đề dự án. Trạng thái (Đang
  làm/Tạm dừng/Đã xong) giờ nằm cùng dòng với tên dự án: hàng flex
  `.titlerow` (tên bên trái, viên trạng thái bên phải, tên dài thì
  tự xuống dòng), áp dụng cả ở thẻ dự án trong danh sách lẫn màn chi
  tiết dự án.
- Kiểm chứng: trang thật có đủ `.atitle`, `.titlerow`; script trang
  thật `node --check` OK; harness 4 kiểm tra đạt (danh sách + chi
  tiết: tên tài khoản xanh, trạng thái cùng dòng với tên dự án, viên
  note nhà cung cấp vẫn còn).

## Thiết kế lại toàn bộ theo chuẩn Refactoring UI / M3 / iOS HIG 2026-11-06

- Anh chê giao diện vẫn xấu, yêu cầu nghiên cứu skill thiết kế trên
  mạng rồi thiết kế lại. Đã chạy nghiên cứu sâu (deep research) và
  có bản hướng dẫn đầy đủ: `research_notes/mobile-app-ui-redesign-20261106-1103/report.md`
  + trang hướng dẫn tương tác "Thiết kế lại giao diện" (artifact,
  có bản mẫu app chạy thật trong khung máy + giải trình hệ thống).
- Áp vào app thật (`src/worker.js`): toàn bộ CSS viết lại theo token
  `:root` — thang khoảng cách 4px (lề 16, thẻ 20, khe 12–16), bán
  kính 8/12/16/20, bóng mềm 2 lớp (`--shadow-card`), màu nền trang
  `#F1F5F9`, chữ `#0F172A`/`#475569`/`#64748B`, nút chính xanh lá
  đậm `#047857` (đủ tương phản chữ trắng).
- Chữ: Be Vietnam Pro (font làm riêng cho tiếng Việt, dấu không vỡ)
  qua Google Fonts, fallback system-ui; số thống kê 30px/700; tiêu
  đề màn 21px/700; tiêu đề thẻ 16px/600; ô nhập 48px, cỡ chữ 16px
  (không bị iOS tự phóng to khi bấm).
- Header: gradient dịu 2 tông đậm `#047857 → #0F766E` (thay 3 tông
  chói trước đây); thẻ trắng bo 16px, viền mảnh `#E2E8F0` + bóng
  mềm; thanh tab dưới: nền trắng mờ + blur, viền trên mảnh, icon
  24px + nhãn 11px, tab đang chọn có viên pill xanh nhạt + chữ
  xanh đậm, chừa safe-area cho iPhone.
- Nút bấm/nút tab/thẻ có phản hồi nhấn (`scale(.97)`, 120ms);
  chuyển màn có hiệu ứng mờ + trượt nhẹ 180ms; tôn trọng
  `prefers-reduced-motion` (tắt hết chuyển động).
- Màn trống (chưa có dự án/tài khoản) giờ có hình minh họa + giải
  thích + 1 nút hành động ("+ Thêm dự án"/"+ Thêm tài khoản", bấm
  là mở đúng form thêm mới qua hàm `goAdd`).
- GIỮ NGUYÊN theo ý anh đã chốt: tiêu đề dự án/tài khoản màu xanh
  (bản hướng dẫn gốc đề nghị bỏ chữ xanh, nhưng anh đã chọn xanh 2
  lần nên em giữ), rắn 🐍 + ngựa 🐎, chọn nền trang 5 màu + tải ảnh,
  không tím, nhãn note, gạch đầu dòng chỉ đậm nhãn.
- Kiểm chứng: trang thật có đủ font/token/bóng/tab pill/trạng thái
  trống; script trang thật `node --check` OK; harness 9 kiểm tra
  đạt (thống kê 3/6/8, danh sách + chi tiết, màn trống + CTA, mở
  đúng form, chọn nền + về mặc định). Lưu ý của bản hướng dẫn:
  trong bản mẫu tương tác, 2 nút Lưu dự án và Xuất toàn bộ nằm dưới
  vùng cuộn nên probe kiểm thử chưa bấm được (vuốt trong khung là
  tới); font Be Vietnam Pro bị chặn trong môi trường kiểm thử, mở
  bằng trình duyệt thật sẽ tải bình thường.

## Tối ưu tốc độ + cài đặt app (PWA) 2026-11-06

- Anh báo load quá chậm, yêu cầu tối ưu + thêm chức năng cài đặt
  app. Đo thật từ máy chủ: trang HTML 32KB tải ~0,7s; API ~0,45s;
  riêng **stylesheet font Be Vietnam Pro mất ~1s và CHẶN hiển thị**
  (thẻ `<link rel=stylesheet>` trong `<head>`) — đây là thủ phạm
  chính, do chính vòng thiết kế lại trước đó thêm vào.
- Đã sửa:
  - Font tải **không chặn hiển thị** (`media="print"` +
    `onload="this.media='all'"`): trang hiện ngay bằng font hệ
    thống, font đẹp về sau thì đổi sang — lần đầu mở không còn
    chờ ~1s trắng trang.
  - **Service worker** (`/sw.js`, cache `stk-v2`): vỏ trang
    (stale-while-revalidate — mở là hiện ngay từ cache, cập nhật
    ngầm), font cache-first, API chỉ đi mạng (dữ liệu luôn mới).
  - ETag cho vỏ trang (`Cache-Control: public, max-age=0,
    must-revalidate`): **đã kiểm chứng Cloudflare lược bỏ header
    ETag trên đường về** (trả 200, không có ETag, dù code đúng) nên
    304 chưa về được từ máy kiểm tra — service worker bù lại cho
    các lần mở sau, không cần ETag.
- **PWA — cài được lên màn hình chính:** manifest
  (`/manifest.webmanifest`, standalone, theme `#047857`), icon
  "Sổ" tự vẽ bằng PIL (192/512/maskable, nền xanh lá `#047857`,
  chữ trắng), service worker đăng ký khi mở trang.
- **Nút "📲 Cài đặt app" trong màn Cài đặt:** hiện khi trình duyệt
  gửi lời mời cài (`beforeinstallprompt`); bấm là hiện hộp cài của
  hệ thống. iPhone không có lời mời đó nên hiện hướng dẫn "bấm nút
  Chia sẻ rồi chọn Thêm vào Màn hình chính". Đã cài rồi (mở từ icon)
  thì nút ẩn, hiện "App đã được cài đặt trên thiết bị này."
- Kiểm chứng: manifest/sw.js/3 icon đều 200 (PNG đúng định dạng);
  sw.js `node --check` OK; harness 9 kiểm tra đạt (mở app, hiện
  nút khi có lời mời, bấm cài gọi đúng hộp thoại, iOS hiện hướng
  dẫn, đã cài ẩn nút, đăng ký service worker, danh sách + chọn nền
  vẫn chạy). Lưu ý: lần mở đầu sau bản này vẫn tải mới (service
  worker mới cài), từ lần thứ hai trở đi mở là hiện ngay.

## Sửa cài đặt app (PWA) — lần 2, 2026-11-06

- Anh báo "Cài đặt app chưa được". Kiểm tra bằng trình duyệt thật:
  manifest hợp lệ, sw.js hợp lệ, 3 icon tải đúng, 5 URL precache
  đều 200 — nhưng trình duyệt kiểm tra không có DevTools nên không
  xác nhận được service worker có đăng ký thật không và lời mời cài
  có hiện không. Tự kiểm tra lại trang thật: link manifest + lệnh
  đăng ký service worker đều có trong HTML — vậy lỗi nằm ở các
  điểm yếu sau, đã sửa hết:
  - Service worker trước đây đăng ký **sau khi trang tải xong**
    (sự kiện load) — lần mở đầu tiên lời mời cài có thể trượt mất.
    Nay đăng ký **ngay khi script chạy**.
  - Precacher `caches.addAll` kiểu "một lỗi là hỏng tất cả": 1 file
    lỗi là cả service worker không cài được → không đủ điều kiện
    cài app. Nay cache từng file riêng, lỗi file nào bỏ qua file đó
    (cache `stk-v3`).
  - Nút "Cài đặt app" trước đây **chỉ hiện khi trình duyệt gửi lời
    mời** (`beforeinstallprompt`) — trình duyệt không gửi (Samsung
    Internet, đã từng từ chối, lần mở đầu...) thì người dùng không
    thấy gì để bấm. Nay nút **luôn hiện** (trừ khi đã cài rồi hoặc
    iPhone); bấm mà trình duyệt chưa hiện hộp cài thì app chỉ đúng
    cách làm tay: menu ⋮ (góc phải trên) → Thêm vào Màn hình chính.
- Kiểm chứng: sw.js `stk-v3` + precache riêng lẻ; trang thật có đủ
  manifest/SW/nút; harness 10 kiểm tra đạt (đăng ký SW ngay khi mở
  trang, nút hiện ngay cả khi chưa có lời mời, bấm không lời mời →
  hiện hướng dẫn làm tay, có lời mời → gọi đúng hộp cài, iOS và đã
  cài vẫn đúng, danh sách + chọn nền vẫn chạy).
- Cách cài cho anh: tải lại app một lần → đăng nhập → Cài đặt →
  Cài đặt app → bấm nút. Nếu bấm mà không hiện hộp cài thì làm tay:
  menu ⋮ của trình duyệt → Thêm vào Màn hình chính.

## Cài đặt app ngay màn đăng nhập 2026-11-06

- Anh yêu cầu: để cài đặt app ngay màn đăng nhập (trước đây nút cài
  chỉ có trong Cài đặt, phải đăng nhập mới tới được).
- Đã làm: thêm khối "📲 Cài đặt app" (nút + dòng trạng thái) ngay
  dưới nút Đăng nhập trên màn đăng nhập; giữ nguyên khối trong màn
  Cài đặt. Hai chỗ dùng chung một logic qua class
  `.installBtn`/`.installStatus` (`querySelectorAll`) — bấm ở đâu
  thì cả hai chỗ cùng đổi trạng thái. Nút trong màn đăng nhập rộng
  bằng ô nhập (`#login .installBtn{width:100%}`).
- Kiểm chứng: trang thật có khối cài đặt ngay sau nút Đăng nhập +
  đủ 2 nút/2 dòng trạng thái, không còn id cài đặt cũ; harness đạt
  (chưa đăng nhập → màn đăng nhập hiện + nút cài hiện; bấm không
  lời mời → hướng dẫn làm tay hiện ở cả hai chỗ; có lời mời → gọi
  đúng hộp cài; iOS hiện hướng dẫn riêng).

## Thêm sửa/xoá 2026-11-06

- Anh yêu cầu thêm chức năng sửa và xoá. API sửa/xoá dự án, tài
  khoản, liên kết đã có từ GĐ1; chỉ thiếu sửa tài nguyên và sửa vai
  trò liên kết — đã thêm: `PUT /api/resources/:id` (đổi được cả tài
  khoản chủ) và `GET`/`PUT /api/projects/:id/accounts/:accountId`
  (đổi vai trò + ghi chú; đổi sang vai trò đã gắn rồi → 409).
- Giao diện:
  - Thẻ danh sách (dự án + tài khoản): thêm nút **✏️ Sửa**,
    **🗑️ Xoá** cạnh nút Chi tiết.
  - Màn chi tiết dự án: **✏️ Sửa dự án / 🗑️ Xoá dự án**; mỗi tài
    khoản gắn vào có **✏️ Vai trò** (sửa vai trò + ghi chú) và
    **🔗 Gỡ** (gỡ liên kết); mỗi tài nguyên có **✏️ / 🗑️**.
  - Màn chi tiết tài khoản: **✏️ Sửa tài khoản / 🗑️ Xoá tài
    khoản**; mỗi dự án có **🔗 Gỡ**; mỗi tài nguyên có **✏️ / 🗑️**.
  - Sửa dùng lại đúng form Thêm mới (điền sẵn dữ liệu, tiêu đề
    đổi thành "Sửa…", nút thành "Lưu thay đổi"); mở form thêm mới
    thì tự xóa trạng thái sửa + xóa trắng các ô. Form dự án thêm ô
    Link; form tài khoản thêm ô Hết hạn (ngày); form tài nguyên
    thêm ô Ghi chú — các ô mới dùng được cả khi thêm mới.
  - Xoá hỏi xác nhận (`confirm`) trước khi xoá; bấm Hủy thì không
    làm gì. Xoá dự án gỡ luôn các liên kết. Xoá tài khoản đang còn
    gắn dự án thì server chặn 409 và báo "gỡ liên kết trước" — phải
    gỡ hết liên kết rồi mới xoá được. Sau khi sửa/xoá thì ở lại đúng
    màn chi tiết đang xem (tải lại), sửa từ danh sách thì về danh
    sách.
- Sự cố trong lúc làm: một bản deploy giữa chừng (21:18) chứa script
  lỗi (dư một dấu `}` trong hàm showForm) khiến toàn bộ JavaScript
  của app chết — đã phát hiện qua kiểm tra script trang thật và
  deploy bản sửa ngay lúc 21:24. Bài học: `node --check` file Worker
  KHÔNG đủ (file chỉ là chuỗi, lỗi trong chuỗi vẫn qua) — bắt buộc
  phải `node --check` script đã phục vụ trên trang thật sau mỗi lần
  deploy. Ngoài ra: dấu nháy trong HTML sinh ra giữa chuỗi JS phải
  viết `class=danger` (không dấu nháy) thay vì `class="ghost danger"`
  — dấu nháy kép bị Worker nuốt mất khi ráp chuỗi, làm vỡ script.
- Kiểm chứng: script trang thật `node --check` OK; harness 20 kiểm
  tra đạt (sửa dự án/tài khoản/tài nguyên/vai trò → đúng PUT, xoá →
  đúng DELETE, bấm Hủy thì không gọi API, xoá tài khoản đang gắn →
  hiện đúng lỗi 409, form thêm mới xóa trắng sau khi sửa). Các
  endpoint API mới chưa kiểm chứng trực tiếp bằng tài khoản Admin
  (mật khẩu chỉ anh biết) — lần sửa/xoá thật đầu tiên của anh trên
  app sẽ là kiểm chứng cuối.

## Nút Hủy + rà soát toàn bộ kiểu lập trình viên lâu năm 2026-11-06

- Anh hỏi: sửa chỉ có Lưu thay đổi mà không có Hủy à — đúng, đã
  thiếu. Nay cả 4 form (thêm/sửa dự án, tài khoản, gắn tài khoản,
  tài nguyên) đều có **Lưu + Hủy nằm cạnh nhau** trên một hàng.
  Bấm Hủy thì bỏ hết thay đổi chưa lưu, xóa trắng form, trả tiêu
  đề/nút về dạng thêm mới: đang sửa thì quay lại đúng màn chi tiết
  đang xem; đang thêm mới thì quay lại đúng danh sách (Dự án hay
  Tài khoản) đang xem trước đó.
- Rà soát toàn bộ, phát hiện và sửa thêm:
  - **API sửa không kiểm tra dữ liệu vào** (POST thì có, PUT thì
    không): lưu tên trống là thành dự án/tài khoản không tên.
    Nay PUT dự án/tài khoản/tài nguyên kiểm tra đúng như POST;
    PUT tài nguyên còn kiểm tra tài khoản chủ có tồn tại không
    (vì sửa được phép chuyển tài nguyên sang tài khoản khác).
  - **Xuất dữ liệu thiếu mất phần quan trọng nhất**: bản xuất cũ
    chỉ có dự án/tài khoản/tài nguyên, MẤT liên kết dự án–tài
    khoản và ghi chú bí mật — khôi phục từ đó là mất hết quan hệ.
    Nay xuất đủ cả liên kết lẫn bí mật (chỉ metadata, không giá
    trị). Đồng thời nút Xuất giờ **tải về file JSON đầy đủ**
    (so-tai-khoan-YYYY-MM-DD.json) thay vì chỉ hiện 4000 ký tự đầu
    cho xem.
  - **Đổi mật khẩu không thu hồi phiên khác**: trước đây đổi mật
    khẩu xong, máy khác đang đăng nhập vẫn dùng tiếp. Nay đổi mật
    khẩu thì đăng xuất hết các phiên khác, chỉ giữ phiên hiện tại.
  - **Hàm thoát ký tự HTML thiếu dấu nháy**: tên dự án/tài khoản
    có dấu `'` hoặc `"` có thể làm vỡ HTML. Nay thoát đủ cả hai.
- Đã kiểm tra lại và giữ nguyên có chủ ý: một tài khoản được gắn
  vào cùng một dự án với NHIỀU vai trò khác nhau (vd vừa build
  chính vừa deploy) — đó là thiết kế theo mô hình nhiều-nhiều,
  không phải lỗi trùng; nếu anh muốn mỗi cặp chỉ một vai trò thì
  bảo em đổi ở GĐ2.
- Kiểm chứng: script trang thật `node --check` OK, cân bằng
  ngoặc 0; harness 19/19 đạt (Hủy từ sửa → về đúng chi tiết,
  không lưu gì; Hủy từ thêm mới → về đúng danh sách; lưu sau khi
  hủy vẫn chạy; tên có dấu nháy/thẻ HTML hiện đúng dạng thoát;
  xuất đủ liên kết + bí mật + tải file; sửa/xoá/cài đặt app/nền
  vẫn chạy).

## Nút Chi tiết/Sửa/Xoá nhỏ gọn 2026-11-06

- Anh gửi ảnh chụp: 3 nút trên thẻ to quá, xếp 2+1 chiếm chỗ. Đã
  làm gọn: 3 nút nằm chung một hàng (`.rowbtns` flex, khe 8px),
  nút nhỏ 36px/chữ 14px (`.sm` cho Chi tiết/Sửa, `.smd` đỏ nhạt
  cho Xoá). Các nút nhỏ trong màn chi tiết (Vai trò/Gỡ, sửa/xoá
  tài nguyên) cũng đổi sang cỡ nhỏ cho đồng bộ. Hàng Sửa/Xoá ở
  màn chi tiết giữ nguyên (đã gọn sẵn).
- Kỹ thuật: dùng class đơn không dấu nháy (`class=sm`) — class
  hai từ phải viết `class="..."` sẽ lại vỡ script như lần trước
  (Worker nuốt mất dấu nháy kép khi ráp chuỗi).
- Kiểm chứng: script trang thật `node --check` OK; harness 10/10
  (cả hai loại thẻ đều 3 nút trong đúng một hàng, không còn nút
  ghost cỡ lớn, sửa/xoá vẫn chạy đúng).

## Rà soát toàn bộ 2026-11-06 (21:32)

- Kiểm tra live: health 200, trang chính 200, manifest 200,
  sw.js 200 (cache `stk-v3`), icon 192/512 200, webhook Telegram
  không secret trả 403 đúng. Script trang thật `node --check` OK,
  cân bằng ngoặc nhọn = 0, không còn `ghost danger` hay dấu nháy
  thừa; sw.js `node --check` OK.
- Harness tổng 30 kiểm tra đạt 30/30: tải app + thống kê 3/6/8;
  thẻ danh sách dự án/tài khoản đủ Chi tiết + Sửa + Xoá; tìm kiếm;
  thêm mới dự án/tài khoản/gắn tài khoản/tài nguyên (đúng POST, đủ
  các ô mới Link/Hết hạn/Ghi chú); xem chi tiết + sửa (điền sẵn,
  lưu đúng PUT) + xoá (Hủy thì không gọi API, đồng ý thì DELETE +
  thông báo) cho cả 4 loại; xoá tài khoản đang gắn → đúng lỗi 409;
  sửa vai trò liên kết (PUT kèm old_role) + gỡ liên kết (DELETE kèm
  role); form thêm mới xóa trắng sau khi sửa; xuất JSON hiện đủ;
  chọn nền lưu + áp dụng; cài đặt app hiện ở cả màn đăng nhập lẫn
  Cài đặt, bấm không lời mời thì hiện hướng dẫn làm tay, có lời mời
  thì gọi đúng hộp cài.
- Không phát hiện lỗi mới. Các mục đã biết vẫn chờ GĐ2 (chặn gắn
  trùng, backup tự động R2, kiểm chứng sống, nhắc hết hạn) và chờ
  anh: xác nhận bot Telegram trả lời đúng, nhập tài khoản AI thật.

## Đổi bố cục mới hẳn — dashboard 2 cột + sidebar 2026-11-06 (23:17)

- Anh: "Build lại giao diện" → chọn "Đổi bố cục mới hẳn".
- Bố cục mới (thay hẳn khung cũ header trên + 1 cột):
  - Desktop (≥900px): sidebar trái cố định 264px (logo + 5 mục điều hướng
    Thống kê/Dự án/Tài khoản/Thêm mới/Cài đặt + Đăng xuất ở chân) và cột
    nội dung phải với topbar dính (tiêu đề màn hiện tại + Đăng xuất).
    Thanh tab dưới CHỈ còn trên mobile.
  - Danh sách + chi tiết dạng master-detail 2 cột: danh sách trái
    (tối đa 400px), chi tiết phải dính khi cuộn; bấm một mục thì thẻ đó
    viền xanh lá nổi bật (`data-sel=1`); chi tiết không còn nuốt mất
    danh sách như trước.
  - Mobile (<900px): sidebar ẩn, tab dưới giữ nguyên; bấm một mục thì
    chi tiết mở toàn màn hình (lớp phủ, có nút ← Quay lại).
  - Màn Thống kê thành dashboard: 3 thẻ số riêng (Dự án/Tài khoản/Tài
    nguyên) thay cho 1 thẻ gradient; thêm 2 khối "🕐 Mới cập nhật"
    (5 dự án mới nhất, bấm là mở thẳng chi tiết) và "⏰ Sắp hết hạn".
    Rắn 🐍 trên / ngựa 🐎 dưới vẫn giữ nguyên vị trí cũ.
  - Đầu danh sách có hàng tìm kiếm + nút "+ Thêm" (đúng loại đang xem);
    nút "Tìm" thừa đã bỏ (gõ là tìm ngay như trước).
- Giữ nguyên toàn bộ tính năng và quyết định cũ: màu xanh lá + xanh
  ngọc (không tím), tiêu đề xanh, note nhà cung cấp, chỉ đậm nhãn tài
  nguyên, nút nhỏ 1 hàng, nút Hủy ở cả 4 form, chọn nền, cài đặt app
  ở màn đăng nhập + Cài đặt, xuất JSON đủ links + secrets, đổi mật
  khẩu thu hồi phiên khác, PUT kiểm tra dữ liệu.
- Kỹ thuật: viết lại toàn bộ CSS + khung HTML + các hàm showTab /
  renderList / viewProject / viewAccount / loadStats; thêm
  emptyDetailHTML + closeDetail + biến selId; chuyển tab danh sách
  thì tự xoá lựa chọn chi tiết; cache service worker bump stk-v3 →
  stk-v4 (SW có skipWaiting + clients.claim nên lần tải sau là bản mới).
- Kiểm chứng: deploy 200, modified 2026-11-06T16:24:18Z; trang thật
  200 (45.427B) đủ sidebar + 5 snav + topbar + detail/detailWrap +
  statgrid + recentList/expList, không còn header cũ/statcard/grid/#stats;
  script trang thật `node --check` OK, ngoặc 169/169; sw.js stk-v4;
  health 200. Harness mới 41/41 đạt: boot + thống kê (số, mới cập
  nhật, sắp hết hạn, nav đồng bộ 2 nơi); danh sách 3 thẻ dự án / 6 thẻ
  tài khoản đủ 3 nút; xem chi tiết vào pane phải (danh sách còn nguyên,
  thẻ được chọn nổi bật, listCtl không mất); đóng chi tiết về trạng
  thái trống; đổi tab xoá lựa chọn; tìm kiếm đúng query; sửa (điền
  sẵn → PUT → về lại chi tiết) + Hủy (không PUT, về chi tiết); xoá
  (Hủy thì không API, đồng ý thì DELETE); xuất đủ links/secrets + tên
  file đúng; chọn nền lưu + áp dụng; cài đặt app hướng dẫn làm tay;
  sửa vai trò (PUT kèm old_role); CSS mobile/desktop đúng breakpoint.
- Lưu ý: lần mở app đầu sau deploy có thể vẫn thấy bố cục cũ do
  service worker cache — tải lại 1 lần nữa là lên bố cục mới.

## Tìm kiếm trong ô chọn tài khoản/dự án + tối ưu tốc độ + rà soát kỹ 2026-11-06 (23:37)

- Anh gửi ảnh chụp bảng chọn tài khoản (kiểu radio của Android, không
  tìm được khi nhiều tài khoản): "Thêm tìm kiếm chỗ này; và rà soát kỹ
  lại, tối ưu tốc độ".
- Tìm kiếm (3 ô chọn trong form Gắn tài khoản / Thêm tài nguyên):
  - Ô "Tìm dự án…" trên chọn dự án, ô "Tìm tài khoản…" trên chọn tài
    khoản (cả form Gắn lẫn form Tài nguyên). Gõ là lọc ngay theo tên /
    nhà cung cấp / nhãn / định danh (vd gõ "muse", "github",
    "cloudflare", "gmail" đều ra đúng).
  - Tài khoản đang chọn không bao giờ bị lọc mất: nếu nó không khớp từ
    khoá thì vẫn giữ lại đầu danh sách, giá trị chọn không đổi lặng lẽ.
  - Đóng form / mở form khác thì ô tìm kiếm tự xoá trắng, danh sách về
    đủ. Sửa vai trò / sửa tài nguyên vẫn điền sẵn đúng như trước.
- Tối ưu tốc độ (đo bằng kiểm tra, không đoán):
  - Tải danh sách chọn (dự án + tài khoản) trước đây gọi nối tiếp 2
    lượt; nay gọi song song (`Promise.all` kiểu) + cache 60 giây: mở
    form lần 2 trong 1 phút không gọi mạng nữa. Cache bị huỷ ngay sau
    mọi thao tác thêm/sửa/xoá/gỡ (12 điểm), nên không bao giờ thấy
    danh sách cũ sau khi vừa thêm tài khoản mới.
  - Thống kê cũng gọi song song 2 lượt thay vì nối tiếp.
  - Ô tìm kiếm chính trước đây gõ 1 chữ là gọi API 1 lần; nay chờ
    250ms sau khi ngừng gõ mới gọi (debounce) — gõ "giao việc" chỉ còn
    1 lần gọi thay vì ~9 lần.
- Rà soát kỹ — sửa 2 race (phản hồi chậm về sau đè phản hồi mới):
  - Chuyển tab Dự án → Tài khoản nhanh khi mạng chậm: phản hồi dự án
    về muộn không còn vẽ đè lên danh sách tài khoản (ghi nhớ tab lúc
    gọi, khác tab thì bỏ).
  - Bấm liên tiếp 2 dự án: chi tiết chỉ hiện dự án bấm sau cùng, phản
    hồi của dự án bấm trước về muộn thì bỏ.
- Kiểm chứng: deploy 200, modified 2026-11-06T16:40:36Z; trang thật
  200 (48.946B) đủ 3 ô tìm kiếm + renderLinkOptions + debounce +
  song song + chặn race + 12 điểm huỷ cache; script trang thật
  `node --check` OK, ngoặc 181/181; health 200. Harness mới 36/36
  đạt: lọc đủ 5 từ khoá (muse/github/cloudflare/gmail/smart), giữ
  lựa chọn khi bị lọc, xoá trắng khi đóng form, sửa vai trò vẫn chạy;
  song song (2 lượt bắt đầu cùng mili-giây), cache (lần 2 không gọi
  mạng, thêm dự án xong thì gọi lại), debounce (3 phím gõ → 1 lần
  gọi); 2 race đều chặn đúng; hồi quy đầy đủ (boot/thống kê, danh
  sách 2 cột, chi tiết, sửa/Hủy/xoá, xuất, nền, cài đặt app).
- Chưa làm: thay hẳn bảng chọn native bằng dropdown tìm kiếm tự vẽ
  (đẹp hơn nhưng nhiều rủi ro trên Samsung Internet; ô lọc hiện tại
  đã giải quyết đúng nhu cầu "tìm kiếm chỗ này" với ít rủi ro nhất).
  Nếu anh muốn dạng dropdown tự vẽ thì bảo em.

## Popup thông báo trong app (toast + xác nhận) 2026-11-07 (07:52)

- Anh: "Hiện popup các thông báo (không phải popup trình duyệt)".
- Thay toàn bộ hộp thoại trình duyệt bằng popup trong app:
  - Toast: thông báo hiện góc phải trên (mobile: tràn full chiều ngang),
    viền trái xanh lá khi thành công, đỏ khi lỗi; tự tắt sau 3,5 giây,
    có nút ✕ để tắt tay. Dòng `#msg` đỏ cố định trên đầu trang đã bỏ
    (trước đây cả thông báo thành công cũng hiện màu đỏ).
  - Hộp xác nhận: bấm Xoá/Gỡ thì hiện thẻ nổi giữa màn (nền mờ), ghi
    rõ nội dung sẽ xoá + nút Hủy / nút xác nhận đỏ; bấm ra ngoài thẻ
    cũng là Hủy. Không còn `confirm()` của trình duyệt ở đâu cả
    (4 chỗ: xoá dự án / tài khoản / tài nguyên / gỡ liên kết).
  - Mọi thông báo sau thao tác (lưu, xoá, gắn, gỡ, lỗi mạng/lỗi
    server) đều đi qua toast, phân biệt thành công (xanh) và lỗi (đỏ).
    Thông báo trong form (đăng nhập, đổi mật khẩu, ảnh nền) vẫn giữ
    tại chỗ cạnh ô nhập vì đang nhìn form.
- Kiểm chứng: deploy 200, modified 2026-11-07T00:54:43Z; trang thật
  200 (50.691B) đủ #toasts + #confirmOverlay + CSS popup; script
  trang thật `node --check` OK, ngoặc 188/188; health 200; không
  còn `getElementById("msg")` hay `confirm(` nào. Harness mới 32/32
  đạt: modal mở đúng chữ + nút, Hủy thì không gọi API, đồng ý thì
  DELETE + toast xanh đúng chữ (cả 4 loại xoá/gỡ); toast lỗi đỏ hiện
  đúng thông báo server ("Tên dự án bắt buộc"); toast lưu thành công;
  nút ✕ tắt được toast; hồi quy (thống kê, lọc bảng chọn, song song +
  cache + debounce, 2 race, danh sách 2 cột, sửa/Hủy, xuất, nền,
  cài đặt app).

## Chờ (chưa làm — cần anh cấp)
- R2 API Token → backup mã hoá lên R2 (GĐ1 mới có export JSON, chưa có
  backup tự động lên R2).
- Tài khoản AI/build thật (Muse #1/#2, GPT…) — chưa có dữ liệu thật để nhập,
  đang chờ anh gửi danh sách.

## Giai đoạn 2 (dự kiến)

- Kiểm chứng sống qua API GitHub/Cloudflare, nhắc token sắp hết hạn,
  nhật ký đầy đủ trên web, backup tự động lên R2.
