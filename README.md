# Supplier Desk (Ryans BD + StarTech BD to Daraz Sync)

E-commerce inventory and pricing synchronization portal for Bangladeshi electronics retailers (Ryans BD & StarTech BD) with Daraz integration, multi-user authentication, and persistent cloud storage via Upstash Redis.

## Deployment to GitHub & Vercel

### 1. Push to GitHub
1. Initialize git and commit files:
   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   ```
2. Create a repository on GitHub (e.g., `supplierdesk`).
3. Link your local repo and push:
   ```bash
   git remote add origin https://github.com/<your-username>/<repo-name>.git
   git branch -M main
   git push -u origin main
   ```
   *(Note: `.gitignore` is already configured so `node_modules` and `.env` won't be pushed).*

### 2. Deploy on Vercel
1. Go to [vercel.com](https://vercel.com) and click **"Add New Project"**.
2. Select your GitHub repository.
3. In **Environment Variables**, add:
   - `KV_REST_API_URL` (or `UPSTASH_REDIS_REST_URL`): your Upstash REST URL
   - `KV_REST_API_TOKEN` (or `UPSTASH_REDIS_REST_TOKEN`): your Upstash REST Token
4. Click **Deploy**.

`vercel.json` is already configured with `@vercel/node` and automatic asset bundling for `static/` and `data/`.

SupplierDesk syncs product view counts through Daraz's Open Platform item API when the API returns view metrics. If Daraz does not provide a view metric, the existing saved count is preserved.

Daraz Open Platform App Key and App Secret are configured by an administrator and are not returned to seller accounts. Each signed-in user can connect multiple Daraz stores from Settings with **Authorize on Daraz**; the resulting access tokens are stored server-side per user and are never sent to the browser. Admins can view connected-store ownership and seller IDs across users, but not raw access tokens. The active store selection is used for Daraz API actions. Product and order data remain in the app's existing shared workspace.

## Running Locally

1. Install dependencies:
   ```bash
   npm install
   ```
2. Run development server:
   ```bash
   npm run dev
   ```
3. Open `http://localhost:3000` in your browser.
