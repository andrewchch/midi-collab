# midi-collab
A web app for sharing a midi editor session for collaborative editing

## Build & Hosting Instructions

This is a static web application with no build step required. It consists of three files:

- `index.html` – main HTML entry point
- `app.js` – application logic
- `style.css` – styles

### Running Locally

The app includes a Python/Flask server (`server.py`) that serves the static files and can be extended with server-side functionality.

Install dependencies and start the server:

```bash
pip install -r requirements.txt
python server.py
```

Then open `http://localhost:5000` in your browser.

Alternatively, serve the files with any static HTTP server (no Python required):

```bash
# Python 3 built-in
python3 -m http.server 8080
# or Node.js
npx serve .
```

### Deploying to a Hosting Environment

Deploy `server.py` and all static files to any Python-capable hosting platform:

- **Heroku / Render / Railway** – set the start command to `python server.py` (or use a `Procfile`: `web: python server.py`).
- **AWS Elastic Beanstalk / Azure App Service / Google Cloud Run** – package the repository and configure the runtime to run `python server.py`.
- **VPS / bare metal** – install dependencies with `pip install -r requirements.txt` and run `python server.py`. Use a reverse proxy (nginx, Apache) in front of the Flask server for production.

For pure static hosting (without the Python server), upload `index.html`, `app.js`, and `style.css` to any static provider such as GitHub Pages, Netlify, or Vercel.
