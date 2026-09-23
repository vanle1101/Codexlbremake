---
name: "auto-codex-workflow"
description: |
  Tự động nạp tài khoản GPT, cấu hình và khởi chạy Codex (CLI / Desktop) hoàn toàn trên máy local.
  Chạy độc lập 100% không cần VPS, không cần API Key.
metadata:
  author: codex-lb
  version: "1.0.0"
---

# Auto Codex Workflow (100% Local - No VPS - No API Key)

Kỹ năng tự động hóa đăng nhập danh sách tài khoản GPT và khởi chạy Codex lên màn hình khi người dùng yêu cầu:
"log acc và khởi chạy codex lên cho t", "đăng nhập acc rồi bật codex", v.v.

## Khi nào kích hoạt (Triggers)
- Khi người dùng cung cấp danh sách tài khoản GPT (email, mật khẩu, mã 2FA TOTP).
- Khi người dùng gửi prompt yêu cầu:
  - "log acc và khởi chạy codex"
  - "log acc rồi mở codex"
  - "nạp acc bật codex"
  - Hoặc bất kỳ biến thể nào tương tự.

## Quy trình Antigravity cần thực hiện:

1. **Lấy dữ liệu tài khoản từ tin nhắn của người dùng:**
   - Trích xuất toàn bộ các dòng chứa email, password, 2fa_secret.
   - Lưu tạm vào file `accounts_input.txt` trong thư mục làm việc hoặc truyền trực tiếp qua argument `--text`.

2. **Chạy script tự động hóa hoàn toàn cục bộ (100% Local, KHÔNG gọi VPS, KHÔNG cần API Key):**
   ```bash
   python scripts/auto_codex_workflow.py --file accounts_input.txt
   ```
   Hoặc:
   ```bash
   python scripts/auto_codex_workflow.py --text "<danh sách tài khoản>"
   ```

3. **Script này sẽ tự động làm tất cả các bước:**
   - Lọc trùng tài khoản.
   - Dùng Playwright tự động đăng nhập tài khoản vào proxy nội bộ codex-lb (~/.codex-lb/store.db).
   - Lấy 1 tài khoản active, làm mới token và ghi đè vào ~/.codex/auth.json.
   - Cấu hình file ~/.codex/config.toml trỏ về http://127.0.0.1:2455/backend-api/codex (chế độ không cần API key).
   - Tự động gắn lệnh codex vào PATH hệ thống nếu máy tính chưa có.
   - Khởi động dịch vụ proxy local codex-lb ngầm trên cổng 2455 nếu chưa chạy.
   - Bật cửa sổ PowerShell chạy giao diện tương tác codex và mở ứng dụng ChatGPT Desktop lên màn hình.

4. **Xóa file tạm `accounts_input.txt` sau khi xong để bảo mật thông tin tài khoản.**

5. **Báo cáo kết quả ngắn gọn cho người dùng:**
   - Số lượng tài khoản đã đăng nhập thành công.
   - Thông báo Codex đã được mở trên màn hình và sẵn sàng sử dụng.
