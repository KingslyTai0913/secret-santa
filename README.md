# 🎁 家庭交换礼物抽签 · Family Secret Santa

一个给**多个家庭**一起玩的 Secret Santa 抽签网页：**同一个家庭的人不会互相抽到**。
不用安装、不用注册、不需要服务器，手机、电脑、微信里都能直接打开。

A Secret Santa draw for **several families**: **nobody ever draws someone from their own family**.
No install, no sign-up, no server. Works on phones, computers and inside WeChat.

---

## 功能 · Features

- 👨‍👩‍👧 **家庭分组**：家庭数量、每家人数都可以不一样（默认 5 个家庭，可以增减）。
  Families of any size; 5 by default, add or remove as you like.
- 🔒 **同一家庭不互抽**（一直开启），另外可以选：
  **Same family never draws each other** (always on), plus optional rules:
  - **避免两人互抽**（默认关闭）No swaps (off by default): A 抽到 B，B 就不会抽到 A
  - **连成一个大圈** One big loop: A→B→C→…→A
  - **额外限制** Extra exclusions: 比如“今年不要和去年抽到同一个人” / e.g. not the same person as last year
- ✅ **抽之前就检查**：比如某个家庭超过总人数一半（那就一定会有人抽到自家人），或者名字重复，会直接提示。
  Impossible setups (a family with more than half of everyone, duplicate names…) are caught before drawing.
- 🤫 **每个人点自己的名字看结果**：先确认“你是 XX 吗？”，看完会标记“已查看”。
  Everyone taps their own name to see their result; viewed names get a ✓.
- 🔓 **管理员页面**（可以设密码）：看全部结果，并**自动逐条检查有没有抽错**，还有礼物链、复制结果、重新抽签。
  Admin page (PIN-protected) shows every pairing **and automatically re-checks every rule**.
- 🔗 **分享链接**：不在场的家人点开链接，点自己的名字也能看到结果。
  A share link lets family members who aren't there see their own result.
- 🇨🇳🇬🇧 中英双语同时显示；支持深色模式；所有资料只存在本机。
  Bilingual UI, dark mode, all data stays on the device.

## 怎么用 · How to use

1. **打开网页** — 双击 `index.html`，或者打开部署好的网址（见下面）。
   Open `index.html` (double-click) or the hosted URL.
2. **填名单** — 给每个家庭起名字（比如“王家”），加入成员。可以一次粘贴多个名字，用逗号、顿号或换行分开。点「填入示例」可以先试玩。
   Name each family and add members (paste several names at once). "Try a demo" fills in sample data.
3. **设管理员密码**（建议）→ 点 **🎁 抽签并生成链接**。
   Set an admin PIN (recommended) → tap **Draw & create the link**.
4. **发链接**：管理员页面最上面就是链接，点「复制群消息」发到家庭群。⚠️ 网页要先放到网上（见下一节），直接双击打开的本地文件生成的链接，别人打不开。
   **Send the link** at the top of the admin page to the family chat. ⚠️ The page must be online first (next section).
5. **每个人**：打开链接 → 选自己的名字 → 按 **🎲 抽签** → 看到要送礼物给谁。
   **Everyone**: open the link → pick your name → press **Draw** → see who you're buying for.
6. **管理员检查**：管理员页面会显示「✓ 全部符合规则」和每个人抽到谁的完整列表。以后想再看，点「🔒 管理员」输入密码。
   **Admin check**: the admin page shows "✓ Everything checks out" and the full list. Later, open "Admin" with the PIN.

> 大家在一起的话，也可以不发链接：在管理员页面点「← 抽签页面」，用一台设备传着抽。
> If everyone is together, skip the link: tap "← Draw page" and pass one device around.

## 放到网上（GitHub Pages，免费）· Put it online (free)

1. 在 GitHub 新建一个**空**仓库（比如 `secret-santa`），然后在这个文件夹里运行：
   Create an **empty** GitHub repo, then run in this folder:
   ```bash
   git init -b main
   git add .
   git commit -m "Family Secret Santa"
   git remote add origin https://github.com/<你的用户名>/secret-santa.git
   git push -u origin main
   ```
2. 仓库页面 → **Settings → Pages** → Source 选 **Deploy from a branch**，Branch 选 `main` / `(root)` → **Save**。
   Repo → Settings → Pages → Deploy from a branch → `main` / `(root)` → Save.
3. 等一两分钟，网址是 `https://<你的用户名>.github.io/secret-santa/`。用这个网址打开、抽签，再复制分享链接。
   After a minute or two the site is live at that address. Draw from there, then copy the share link.

> 网页里没有任何名单。名字只存在抽签那台设备的浏览器里，以及你发出去的分享链接里。
> The published page contains no names. Names live only in the organiser's browser and inside the share links you send.

也可以用其他静态网站托管，比如 Netlify Drop（把文件夹拖进去就行）。
Any static host works too, e.g. Netlify Drop.

## 抽签算法 · How the draw works

- **结果在管理员按「抽签并生成链接」时一次分配好**，家人按「抽签」只是揭晓。这样才能保证每个人都抽得到合规的人：如果每个人各自现场随机抽，抽到最后可能只剩自己家的人可以抽，而且还需要服务器记录谁已经被抽走。
  The whole draw is made at once when the organiser creates the link; pressing "Draw" reveals your part. Drawing one by one could leave the last person with only their own family, and would need a server.
- **完全随机、公平**：随机打乱，如果不符合规则就重新打乱，直到符合为止（rejection sampling）。这样**每一种符合规则的结果，被抽中的机会完全一样**。用的是浏览器的加密级随机数（`crypto.getRandomValues`）。
  Random permutation + retry until every rule holds, so **every valid outcome is equally likely**. Uses crypto-grade randomness.
- **规则很严格时**（比如额外限制很多），会自动改用回溯搜索，保证能找到结果，或者明确告诉你“这些规则下不可能抽成”。
  With very tight rules it falls back to a backtracking search that either finds a valid draw or proves none exists.
- **能不能抽成**：只要**没有任何一个家庭超过总人数的一半**，就一定能抽成。比如总共 15 人，最大的家庭最多 7 人。
  A draw is possible as long as **no family has more than half of all people**.

## 隐私和安全 · Privacy notes

- 所有资料只保存在这台设备的浏览器里（localStorage），不会上传到任何服务器。
  Everything is stored in the browser only; nothing is uploaded.
- 分享链接里的名字是**打乱编码**过的，一眼看不出谁抽到谁，但它**不是加密**：懂技术的人还是能解开。
  Share links are scrambled, not encrypted.
- 管理员密码只存“指纹”（hash），不存密码本身；它能防止家人随手点开，但挡不住专门破解的人。
  The admin PIN is stored as a hash. It's a speed bump for family members, not real security.
- 拿到链接或手机的人，技术上可以点别人的名字。这是给家人玩的，靠大家自觉 😉
  Anyone holding the link or phone could tap someone else's name. It's for family, so it runs on trust 😉

## 开发 · Development

只用原生 HTML/CSS/JavaScript，不依赖任何库，也不需要编译。
Plain HTML/CSS/JS, no dependencies, no build step.

| 文件 File | 内容 What |
|---|---|
| `index.html` | 页面结构 Page markup |
| `styles.css` | 样式（含深色模式）Styles incl. dark mode |
| `santa-core.js` | 抽签、规则检查、分享链接编码（纯函数，可测试）Draw, verification, link encoding |
| `app.js` | 界面逻辑 UI logic |
| `tests/santa-core.test.js` | 单元测试 Unit tests |

```bash
npm test        # 或 / or: node --test tests/santa-core.test.js
```

测试会检查：上千种随机家庭组合下每次抽签都符合规则、每种结果概率相同（卡方检验）、不可能的情况会被正确识别、分享链接能正确还原。
Tests cover thousands of random family setups, uniformity (chi-square), impossible setups, and share-link round trips.

## 参考 · Inspired by

[sts10/fgift](https://github.com/sts10/fgift) ·
[QuentinRoy/santas-de-roy](https://github.com/QuentinRoy/santas-de-roy) ·
[guewen/gifts](https://github.com/guewen/gifts) ·
[gift-exchange (npm)](https://www.npmjs.com/package/gift-exchange) ·
[effigies/santomatic](https://github.com/effigies/santomatic)
