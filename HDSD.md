# HƯỚNG DẪN SỬ DỤNG VÀ KẾT NỐI API CODEX-LB

Tài liệu hướng dẫn kết nối API, tích hợp Extension/Ứng dụng, quản trị Dashboard và xoay tài khoản tự động.

---

## 1. THÔNG TIN HỆ THỐNG & ĐĂNG NHẬP

| Dịch vụ | Địa chỉ | Ghi chú |
| :--- | :--- | :--- |
| **Web Dashboard** | `https://codex.vorte.me/dashboard` | Quản trị tài khoản, xem thống kê & tạo API Key |
| **Mật khẩu Dashboard** | `admin123456` | Có thể đổi trong mục *Cài đặt* |
| **API Base URL (Cloud)** | `https://codex.vorte.me/v1` | Dùng cho khách hàng, Extension, App ngoài |
| **Chat Completions URL** | `https://codex.vorte.me/v1/chat/completions` | Chuẩn OpenAI tương thích 100% |
| **Local Proxy (Nội bộ)** | `http://127.0.0.1:2455/v1` | Dùng cho Codex CLI / Desktop trên máy |

---

## 2. DANH SÁCH MODEL HỢP LỆ (⚠️ QUAN TRỌNG)

Hệ thống sử dụng luân chuyển tài khoản ChatGPT qua giao thức Codex của OpenAI.

> ❌ **KHÔNG ĐƯỢC DÙNG `gpt-4o`**: Upstream ChatGPT Codex không hỗ trợ tên model `gpt-4o` (gọi sẽ bị báo lỗi `400: The 'gpt-4o' model is not supported`).

### ✅ Các Model được hỗ trợ:
- **`gpt-5.5`** ⭐ *(Khuyên dùng nhất: cực kỳ nhanh, ổn định, trả lời mượt mà cho Extension & Chatbot)*
- **`gpt-5.6-luna`** *(Bản nhẹ, tốc độ cao)*
- **`gpt-6-luna`** *(Model thông minh cao cấp)*
- **`gpt-6-sol`** *(Model tư duy sâu)*
- **`gpt-6-astra`** *(Model đa tác vụ)*

---

## 3. CÁCH TẠO API KEY CẤP CHO KHÁCH HÀNG

1. Truy cập [https://codex.vorte.me/dashboard](https://codex.vorte.me/dashboard).
2. Nhập mật khẩu: `admin123456`.
3. Vào tab **API Keys** trên thanh menu trái.
4. Bấm **Tạo Key mới (Create Key)**:
   - Đặt tên cho khách (ví dụ: `Khach_Extension_A`).
   - Cài đặt hạn mức (Quota/Rate limit) nếu cần.
5. Sao chép chuỗi Key (dạng `sk-...`) gửi cho khách hàng.

---

## 4. CODE MẪU CHO KHÁCH TÍCH HỢP (JAVASCRIPT / EXTENSION)

### A. Dùng cho Chrome / Edge Extension (JavaScript `fetch` thuần)

> **Lưu ý cho Extension:** Trong file `manifest.json`, khách bắt buộc phải khai báo quyền kết nối domain:
> ```json
> "host_permissions": [
>   "https://codex.vorte.me/*"
> ]
> ```

#### 1. Nhận phản hồi dạng văn bản (Non-Streaming):
```javascript
async function askAI(prompt) {
  const response = await fetch("https://codex.vorte.me/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // Điền API key bạn cấp cho khách:
      "Authorization": "Bearer sk-your-api-key"
    },
    body: JSON.stringify({
      model: "gpt-5.5", // ⚠️ Bắt buộc dùng gpt-5.5 hoặc gpt-6-luna, không dùng gpt-4o
      messages: [
        { role: "user", content: prompt }
      ]
    })
  });

  if (!response.ok) {
    const errorMsg = await response.text();
    throw new Error(`Lỗi (${response.status}): ${errorMsg}`);
  }

  const data = await response.json();
  return data.choices[0].message.content;
}

// Gọi thử:
askAI("Xin chào, bạn là ai?")
  .then(reply => console.log("AI trả lời:", reply))
  .catch(err => console.error(err));
```

#### 2. Nhận chữ chạy từng từ (Streaming realtime):
```javascript
async function askAIStream(prompt, onTextChunk) {
  const response = await fetch("https://codex.vorte.me/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer sk-your-api-key"
    },
    body: JSON.stringify({
      model: "gpt-5.5",
      messages: [{ role: "user", content: prompt }],
      stream: true
    })
  });

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const chunk = decoder.decode(value);
    const lines = chunk.split("\n");
    for (const line of lines) {
      if (line.startsWith("data: ") && line !== "data: [DONE]") {
        try {
          const json = JSON.parse(line.slice(6));
          const text = json.choices[0]?.delta?.content || "";
          if (text) onTextChunk(text);
        } catch (e) {}
      }
    }
  }
}

// Gọi thử:
askAIStream("Viết một đoạn giới thiệu về bạn", (chunk) => {
  process.stdout.write(chunk); // hoặc chèn vào giao diện Extension
});
```

---

### B. Dùng Thư viện chính thức `openai` (Node.js / React / Next.js)

```bash
npm install openai
```

```javascript
import OpenAI from "openai";

const openai = new OpenAI({
  baseURL: "https://codex.vorte.me/v1",
  apiKey: "sk-your-api-key",
  dangerouslyAllowBrowser: true // Bật nếu chạy trực tiếp ở trình duyệt / Extension
});

async function main() {
  const completion = await openai.chat.completions.create({
    model: "gpt-5.5",
    messages: [{ role: "user", content: "Xin chào!" }],
  });

  console.log(completion.choices[0].message.content);
}

main();
```

---

### C. Dùng Python SDK

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://codex.vorte.me/v1",
    api_key="sk-your-api-key"
)

response = client.chat.completions.create(
    model="gpt-5.5",
    messages=[{"role": "user", "content": "Xin chào!"}]
)

print(response.choices[0].message.content)
```

---

### D. Test nhanh qua lệnh cURL (Terminal / Command Prompt)

```bash
curl -X POST https://codex.vorte.me/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-your-api-key" \
  -d '{
    "model": "gpt-5.5",
    "messages": [{"role": "user", "content": "Ping"}]
  }'
```

---

## 5. HƯỚNG DẪN CẤU HÌNH CODEX TRÊN MÁY TÍNH

Khi bạn sử dụng **Codex CLI** hoặc ứng dụng **ChatGPT Desktop** trên máy:

File cấu hình tại `C:\Users\acer\.codex\config.toml`:
```toml
model = "gpt-6-astra"
model_reasoning_effort = "xhigh"
model_provider = "codex-lb"

[model_providers.codex-lb]
name = "openai"
base_url = "http://127.0.0.1:2455/backend-api/codex"
wire_api = "responses"
supports_websockets = true
requires_openai_auth = true
```

Lệnh mở giao diện Codex trong Terminal:
```bash
codex
```
