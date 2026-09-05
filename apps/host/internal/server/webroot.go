package server

import (
	"errors"
	"io"
	"io/fs"
	"mime"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"
)

// WebRoot serves the built front end from a directory (canvas platform design
// §3 H02). It is the one surface a device may reach before it is paired: the
// application shell is also the pairing page, and it carries no workspace,
// terminal or file data of its own. Everything the shell then asks for goes
// through the authenticated proxy.
//
// Traversal is prevented structurally rather than by string matching: the whole
// tree is opened through an os.Root, so a symlink inside the bundle cannot
// point the Host at anything outside it.
type WebRoot struct {
	root  *os.Root
	dir   string
	index []byte
}

// OpenWebRoot validates the directory once, at start-up, so a mistyped path is
// a refusal to start rather than a 404 the operator discovers from a phone.
func OpenWebRoot(dir string) (*WebRoot, error) {
	if dir == "" {
		return nil, errors.New("web root directory is empty")
	}
	absolute, err := filepath.Abs(dir)
	if err != nil {
		return nil, err
	}
	root, err := os.OpenRoot(absolute)
	if err != nil {
		return nil, errors.New("could not open the web root directory")
	}
	index, err := readRootFile(root, "index.html")
	if err != nil {
		root.Close()
		return nil, errors.New("the web root must contain an index.html")
	}
	return &WebRoot{root: root, dir: absolute, index: index}, nil
}

// Dir is the directory this root serves.
func (web *WebRoot) Dir() string { return web.dir }

// Close releases the directory handle.
func (web *WebRoot) Close() error {
	if web == nil || web.root == nil {
		return nil
	}
	return web.root.Close()
}

func readRootFile(root *os.Root, name string) ([]byte, error) {
	file, err := root.Open(name)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return nil, errors.New("not a regular file")
	}
	return io.ReadAll(io.LimitReader(file, 8<<20))
}

// contentTypes is explicit for the types the bundle actually ships. The OS mime
// database is consulted only for the rest, and an unknown type is served as an
// octet stream rather than as something a browser might execute.
var contentTypes = map[string]string{
	".html":  "text/html; charset=utf-8",
	".js":    "text/javascript; charset=utf-8",
	".mjs":   "text/javascript; charset=utf-8",
	".css":   "text/css; charset=utf-8",
	".json":  "application/json; charset=utf-8",
	".svg":   "image/svg+xml",
	".png":   "image/png",
	".jpg":   "image/jpeg",
	".jpeg":  "image/jpeg",
	".webp":  "image/webp",
	".gif":   "image/gif",
	".ico":   "image/x-icon",
	".woff":  "font/woff",
	".woff2": "font/woff2",
	".ttf":   "font/ttf",
	".wasm":  "application/wasm",
	".map":   "application/json; charset=utf-8",
	".txt":   "text/plain; charset=utf-8",
}

// contentSecurityPolicy keeps the served shell talking to this origin only.
// Workers and WebAssembly are allowed because the canvas and the editor use
// them; remote script and framing are not.
const contentSecurityPolicy = "default-src 'self'; " +
	"script-src 'self' 'wasm-unsafe-eval' blob:; " +
	"worker-src 'self' blob:; " +
	"style-src 'self' 'unsafe-inline'; " +
	"img-src 'self' data: blob:; " +
	"font-src 'self' data:; " +
	"media-src 'self' blob:; " +
	"connect-src 'self' blob: data:; " +
	"base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

// Serve answers a GET or HEAD for a static file, falling back to index.html so
// a deep link opened on a phone still boots the application.
func (web *WebRoot) Serve(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		writeError(w, http.StatusMethodNotAllowed, "INVALID_ARGUMENT", "GET required")
		return
	}
	name, ok := staticName(r.URL.Path)
	if !ok {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "Unknown endpoint")
		return
	}
	w.Header().Set("Content-Security-Policy", contentSecurityPolicy)
	w.Header().Set("Referrer-Policy", "same-origin")
	if name != "" {
		if file, info, err := web.open(name); err == nil {
			defer file.Close()
			web.serveFile(w, r, name, file, info)
			return
		} else if isAsset(name) {
			// A missing hashed asset is a stale client, not a route. Falling
			// back to index.html here would answer JavaScript with HTML.
			writeError(w, http.StatusNotFound, "NOT_FOUND", "Unknown endpoint")
			return
		}
	}
	w.Header().Set("Content-Type", contentTypes[".html"])
	http.ServeContent(w, r, "index.html", time.Time{}, strings.NewReader(string(web.index)))
}

func (web *WebRoot) open(name string) (*os.File, fs.FileInfo, error) {
	file, err := web.root.Open(name)
	if err != nil {
		return nil, nil, err
	}
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		file.Close()
		return nil, nil, errors.New("not a regular file")
	}
	return file, info, nil
}

func (web *WebRoot) serveFile(w http.ResponseWriter, r *http.Request, name string, file *os.File, info fs.FileInfo) {
	if kind := typeOf(name); kind != "" {
		w.Header().Set("Content-Type", kind)
	} else {
		w.Header().Set("Content-Type", "application/octet-stream")
	}
	if isAsset(name) {
		// Hashed bundle files never change under their own name, and a phone on
		// a slow link should not refetch the canvas on every reload.
		w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
	}
	http.ServeContent(w, r, path.Base(name), info.ModTime(), file)
}

func typeOf(name string) string {
	extension := strings.ToLower(path.Ext(name))
	if known, ok := contentTypes[extension]; ok {
		return known
	}
	return mime.TypeByExtension(extension)
}

// isAsset marks the immutable, content-addressed part of a Vite build.
func isAsset(name string) bool { return strings.HasPrefix(name, "assets/") }

// staticName turns a request path into a slash-separated name inside the root.
// The empty name means "serve the application shell".
func staticName(urlPath string) (string, bool) {
	if urlPath == "" || urlPath[0] != '/' || strings.ContainsRune(urlPath, 0) {
		return "", false
	}
	cleaned := path.Clean(urlPath)
	if cleaned == "/" || cleaned == "." {
		return "", true
	}
	name := strings.TrimPrefix(cleaned, "/")
	if name == "" || strings.HasPrefix(name, "../") || name == ".." {
		return "", false
	}
	for _, segment := range strings.Split(name, "/") {
		if segment == "" || segment == "." || segment == ".." {
			return "", false
		}
	}
	return name, true
}
