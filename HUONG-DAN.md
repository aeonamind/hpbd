# 🎂 Trang chúc mừng sinh nhật (bản server)

```
.env                 ← MỌI nội dung: tên, tuổi, lời chúc, thư, ảnh, theo dõi...
server.js            ← server Node (không cần npm install), đọc .env và render trang
public/index.html    ← giao diện (không cần sửa)
public/photos/       ← ảnh kỷ niệm (tùy chọn), public/music.mp3 (tùy chọn)
Dockerfile
kustomization.yaml   ← deploy k3s: kubectl apply -k .
k8s/                 ← namespace, deployment, service, ingress
```

## 1. Sửa nội dung — chỉ sửa `.env`
Clone về thì tạo file trước: `cp .env.example .env` (`.env` không được commit vì chứa topic theo dõi và nội dung riêng tư).

| Biến | Ý nghĩa |
|---|---|
| `HER_NAME`, `FROM_NAME`, `AGE` | Tên cô ấy, tên bạn ký cuối thư, tuổi (= số nến và số ngôi sao) |
| `PAGE_TITLE` | Tiêu đề tab trình duyệt |
| `UNLOCK_AT` | Khóa trang tới giờ, ví dụ `2026-11-20T00:00:00+07:00`. Xem trước bằng `?preview` |
| `INTRO` | Các câu mở đầu, ngăn cách bằng `\|` |
| `LETTER` | Lá thư, xuống dòng viết `\n` |
| `WISHES_TITLE`, `WISHES` | Tiêu đề + các điều chúc (ngăn bằng `\|`, bao nhiêu câu cũng được) |
| `PHOTOS` | `photos/1.jpg::Chú thích\|photos/2.jpg::Chú thích` |
| `MUSIC` | Tên file nhạc trong `public/`, ví dụ `music.mp3` |
| `FINAL_TITLE`, `FINAL_MESSAGE` | Lời nhắn cuối |
| `TRACK_TOPIC`, `NTFY_URL` | Thông báo theo dõi (mục 4) |

Trong mọi đoạn văn dùng được `{name}`, `{from}`, `{age}` — đổi `AGE` là tất cả câu chữ tự đổi theo.
**Không** dùng dấu ngoặc kép, mỗi biến một dòng, lưu UTF-8.

## 2. Chạy thử trên máy
```bash
node server.js          # Node 18+; mở http://localhost:8080/?preview
```
Ghi đè nhanh không cần sửa file: `HER_NAME=Lan AGE=20 node server.js`.
Giá trị sai (ví dụ `AGE=abc`, `WISHES` trống) thì server báo lỗi và không khởi động.

## 3. Deploy lên k3s
**Build image** (chọn một cách):
```bash
# a) Có registry
docker build -t ghcr.io/<user>/her-birthday:1.0.0 . && docker push ghcr.io/<user>/her-birthday:1.0.0
#    rồi sửa images.newName trong kustomization.yaml thành ghcr.io/<user>/her-birthday

# b) Không có registry: build trên node k3s và import thẳng vào containerd
docker build -t her-birthday:1.0.0 .
docker save her-birthday:1.0.0 | sudo k3s ctr images import -
#    (cụm nhiều node thì import trên mọi node, hoặc dùng cách a)
```
**Sửa domain** trong `k8s/ingress.yaml` (`birthday.example.com`), rồi:
```bash
kubectl apply -k .
kubectl -n birthday get pods
kubectl -n birthday logs deploy/birthday -f     # xem log theo dõi realtime
```
**Đổi nội dung sau này:** sửa `.env` → `kubectl apply -k .`. ConfigMap được đặt tên kèm hash nên pod tự rollout với nội dung mới, không cần build lại image.
**Đổi ảnh / nhạc / giao diện:** phải build lại image và tăng `newTag`.

⚠️ Thổi nến bằng micro cần **HTTPS**. Có cert-manager thì bỏ comment phần `tls` trong `k8s/ingress.yaml`; nếu không, cô ấy vẫn chạm vào nến để thổi được.

## 3b. Deploy bằng ArgoCD (repo aeonamind/gitops)
- Chart ở `infra/hpbd`, Application ở `apps/hpbd`. Namespace `application`, domain `hpbd.eugenebox.uk`.
- **Nội dung trang (tên, tuổi, lời chúc, thư...) nằm trong Vault `secret/hpbd`**, không nằm trong git (repo gitops công khai).
  Mỗi trường một khóa, tên giống `.env.example`. `INTRO`, `WISHES`, `PHOTOS`: mỗi dòng một mục. `TRACK_TOPIC` cũng ở đây.
- Sửa trên Vault UI hoặc `vault kv patch secret/hpbd AGE=18` → khoảng 1–3 phút sau trang tự đổi, **không cần push, không cần restart pod**
  (External Secrets đọc Vault mỗi 1 phút → Secret mount vào pod dạng file → server đọc lại mỗi 15 giây).
- Giá trị sai (ví dụ `AGE=abc`, `WISHES` trống) sẽ bị bỏ qua, trang giữ nội dung cũ và ghi lỗi vào log pod.
- Push code vào repo này → GitHub Actions build `aeonamind/hpbd:<sha>`, đẩy DockerHub, rồi tự sửa `image.tag` trong gitops.
  Cần secrets của repo: `DOCKER_USERNAME`, `DOCKER_PASSWORD`, `GITOPS_TOKEN`.
- Khi dùng ArgoCD thì bỏ qua `kustomization.yaml`, `k8s/` và `.env` (chỉ dùng chạy tay / chạy local).

## 4. Theo dõi cô ấy đã xem tới đâu
Trình duyệt gửi từng bước về `/api/track`, server ghi log và đẩy tiếp sang ntfy. Topic giờ **chỉ nằm trên server**, người xem không thấy được.
1. Cài app **ntfy**, Subscribe topic trong `TRACK_TOPIC` (mặc định `sn17-4632cc54dc47481f4f`).
2. Bạn nhận tin khi cô ấy: mở link, bấm "Mở ra nhé", thổi nến (bằng mic / nút / chạm), đọc thư, lật hết điều chúc, xem ảnh, thắp đủ sao. Thoát giữa chừng sẽ có tin tóm tắt `✅Mở ✅Nến ⬜Thư ...`.
- Mở bằng `?preview` thì không gửi gì.
- Để `TRACK_TOPIC=` trống: chỉ ghi vào log pod, không push.
- Tự host ntfy trong cụm: đặt `NTFY_URL=http://<service>.<namespace>.svc.cluster.local`.

## Trình tự trải nghiệm
1. 💌 Màn mở đầu có tên cô ấy, chạm "Mở ra nhé" (bật nhạc)
2. ✨ Các câu mở đầu hiện ra từ từ
3. 🎂 Bánh kem `AGE` ngọn nến: thổi vào micro hoặc chạm để thổi → pháo hoa, nhạc Happy Birthday
4. 💌 Phong thư mở ra, lá thư tự viết từng chữ
5. 🃏 Thẻ điều chúc, vuốt hoặc chạm để lật
6. 📷 Ảnh kỷ niệm (nếu có)
7. 🌟 Chạm để thắp `AGE` ngôi sao → thành hình trái tim + lời nhắn cuối
