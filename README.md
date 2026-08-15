# midi-collab
A web app for sharing a midi editor session for collaborative editing

## Build & Hosting Instructions

This is a static web application with no build step required. It consists of three files:

- `index.html` – main HTML entry point
- `app.js` – application logic
- `style.css` – styles

### Running Locally

Serve the files with any static HTTP server. For example, using Python:

```bash
# Python 3
python3 -m http.server 8080
```

Then open `http://localhost:8080` in your browser.

Alternatively, using Node.js with the `serve` package:

```bash
npx serve .
```

### Deploying to a Hosting Environment

Upload all three files (`index.html`, `app.js`, `style.css`) to any static hosting provider. Popular options include:

- **GitHub Pages** – push to a `gh-pages` branch or configure the repository's Pages settings to serve from the `main` branch root.
- **Netlify / Vercel** – connect the repository and deploy; no build command is needed. Leave the build command blank and set the publish directory to `.` (the repository root).
- **AWS S3 / CloudFront**, **Azure Static Web Apps**, or any web server (nginx, Apache) – copy the three files to the document root and serve them directly.
