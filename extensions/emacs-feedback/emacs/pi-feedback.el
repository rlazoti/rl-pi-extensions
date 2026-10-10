;;; pi-feedback.el --- Send source-region feedback to terminal Pi -*- lexical-binding: t; -*-

;; Copyright (C) 2026 Rodrigo Lazoti

;; Author: Rodrigo Lazoti
;; Keywords: tools, convenience
;; Package-Requires: ((emacs "27.1"))

;;; Commentary:

;; Capture feedback for selected regions in file-backed source buffers, queue the
;; notes per project root, and append a JSONL bundle to a matching terminal Pi
;; session inbox.

;;; Code:

(require 'cl-lib)
(require 'json)
(require 'iso8601)
(require 'project)
(require 'seq)
(require 'subr-x)

(defgroup pi-feedback nil
  "Send Emacs source-region feedback to terminal Pi sessions."
  :group 'tools
  :prefix "pi-feedback-")

(defcustom pi-feedback-directory (expand-file-name "~/.pi/emacs-feedback/")
  "Directory containing Pi Emacs feedback sessions and inboxes."
  :type 'directory
  :group 'pi-feedback)

(defvar pi-feedback--queues (make-hash-table :test #'equal)
  "Queued feedback notes keyed by normalized project root.")

(defvar pi-feedback--next-ids (make-hash-table :test #'equal)
  "Next feedback note ids keyed by normalized project root.")

(defun pi-feedback--timestamp ()
  "Return the current time in an ISO-8601 UTC string."
  (let* ((time (current-time))
         (millis (/ (nth 2 time) 1000)))
    (format "%s.%03dZ" (format-time-string "%Y-%m-%dT%H:%M:%S" time t) millis)))

(defun pi-feedback--bundle-id (project-root)
  "Return a generated bundle id for PROJECT-ROOT."
  (secure-hash 'sha256
               (format "%s:%s:%s:%s"
                       (pi-feedback--timestamp)
                       (emacs-pid)
                       (random)
                       project-root)))

(defun pi-feedback--alist-value (key alist)
  "Return KEY from ALIST, accepting symbol or string JSON keys."
  (let ((symbol-entry (assq key alist)))
    (if symbol-entry
        (cdr symbol-entry)
      (cdr (assoc (symbol-name key) alist)))))

(defun pi-feedback--alist-has-key-p (key alist)
  "Return non-nil when ALIST contains KEY as a symbol or string."
  (or (assq key alist)
      (assoc (symbol-name key) alist)))

(defun pi-feedback--normalize-directory (directory)
  "Return DIRECTORY as a truename directory ending in slash."
  (file-name-as-directory (file-truename (expand-file-name directory))))

(defun pi-feedback--project-root ()
  "Return the current project root, normalized as a truename directory."
  (let ((project (project-current nil)))
    (pi-feedback--normalize-directory
     (if project
         (project-root project)
       default-directory))))

(defun pi-feedback--relative-file (project-root absolute-file)
  "Return ABSOLUTE-FILE relative to PROJECT-ROOT, or raise `user-error'."
  (let* ((root (pi-feedback--normalize-directory project-root))
         (file (file-truename (expand-file-name absolute-file))))
    (unless (file-in-directory-p file root)
      (user-error "File is outside the current project root: %s" file))
    (file-relative-name file root)))

(defun pi-feedback--region-active-p ()
  "Return non-nil when the current buffer has an active region."
  (region-active-p))

(defun pi-feedback--capture-region (project-root feedback)
  "Capture the active region as a feedback note for PROJECT-ROOT.

FEEDBACK is the user-authored feedback text.  The returned value is an alist
ready to encode as JSON."
  (unless buffer-file-name
    (user-error "Pi feedback needs a real source file region or selected Magit/diff lines"))
  (unless (pi-feedback--region-active-p)
    (user-error "Select source text before adding Pi feedback"))
  (let ((begin (region-beginning))
        (end (region-end))
        (feedback-text (string-trim (or feedback ""))))
    (when (= begin end)
      (user-error "Selected region is empty"))
    (when (string-empty-p feedback-text)
      (user-error "Feedback text cannot be empty"))
    (let* ((root (pi-feedback--normalize-directory project-root))
           (absolute-file (file-truename (expand-file-name buffer-file-name)))
           (relative-file (pi-feedback--relative-file root absolute-file))
           (end-position (max begin (1- end)))
           (start-line (line-number-at-pos begin))
           (end-line (line-number-at-pos end-position))
           (quote (buffer-substring-no-properties begin end))
           (created-at (pi-feedback--timestamp))
           (id (pi-feedback--allocate-note-id root)))
      `((id . ,id)
        (file . ,relative-file)
        (absoluteFile . ,absolute-file)
        (startLine . ,start-line)
        (endLine . ,end-line)
        (quote . ,quote)
        (feedback . ,feedback-text)
        (createdAt . ,created-at)))))

(defconst pi-feedback--diff-selection-error
  "Select changed lines inside a single Magit diff hunk before adding Pi feedback."
  "User-facing error for unsupported Magit/diff selections.")

(defun pi-feedback--diff-selection-user-error ()
  "Raise the standard Magit/diff selection `user-error'."
  (user-error pi-feedback--diff-selection-error))

(defun pi-feedback--diff-buffer-p ()
  "Return non-nil when the current buffer should use diff feedback capture."
  (memq major-mode '(diff-mode magit-diff-mode magit-status-mode magit-revision-mode)))

(defun pi-feedback--strip-diff-prefix (path)
  "Strip a git diff side prefix from PATH.

Return nil for /dev/null so deleted and added file headers can fall back to the
real side of the diff."
  (when (and (stringp path) (not (equal path "/dev/null")))
    (replace-regexp-in-string "\\`[ab]/" "" path)))

(defun pi-feedback--line-text ()
  "Return the current line without text properties or trailing newline."
  (buffer-substring-no-properties (line-beginning-position) (line-end-position)))

(defun pi-feedback--parse-hunk-header (line)
  "Parse unified diff hunk header LINE.

Return an alist containing oldStart, oldCount, newStart, newCount, and header.
Counts omitted by the diff default to 1."
  (when (string-match
         "\\`@@ -\\([0-9]+\\)\\(?:,\\([0-9]+\\)\\)? +\\+\\([0-9]+\\)\\(?:,\\([0-9]+\\)\\)? @@.*\\'"
         line)
    `((oldStart . ,(string-to-number (match-string 1 line)))
      (oldCount . ,(if (match-string 2 line)
                       (string-to-number (match-string 2 line))
                     1))
      (newStart . ,(string-to-number (match-string 3 line)))
      (newCount . ,(if (match-string 4 line)
                       (string-to-number (match-string 4 line))
                     1))
      (header . ,line))))

(defun pi-feedback--diff-line-kind ()
  "Classify the current unified diff line."
  (let ((line (pi-feedback--line-text)))
    (cond
     ((string-prefix-p "diff --git " line) 'file)
     ((string-prefix-p "@@" line) 'hunk)
     ((string-prefix-p "\\ No newline at end of file" line) 'metadata)
     ((string-prefix-p "+" line) 'added)
     ((string-prefix-p "-" line) 'removed)
     ((string-prefix-p " " line) 'context)
     (t 'metadata))))

(defun pi-feedback--format-range (start end)
  "Format START and END as a compact one-based line range."
  (if (equal start end)
      (format "%s" start)
    (format "%s-%s" start end)))

(defun pi-feedback--format-diff-location (file line-side old-start old-end new-start new-end)
  "Format a diff note location for FILE and LINE-SIDE.

LINE-SIDE must be \"new\", \"old\", \"mixed\", or the equivalent symbol."
  (let ((side (if (symbolp line-side) (symbol-name line-side) line-side)))
    (cond
     ((equal side "old")
      (format "%s:old %s" file (pi-feedback--format-range old-start old-end)))
     ((equal side "mixed")
      (format "%s:mixed old %s / new %s"
              file
              (pi-feedback--format-range old-start old-end)
              (pi-feedback--format-range new-start new-end)))
     (t
      (format "%s:%s" file (pi-feedback--format-range new-start new-end))))))

(defun pi-feedback--diff-file-header-path (line marker)
  "Return the path from a ---/+++ LINE starting with MARKER."
  (when (string-match (concat "\\`" (regexp-quote marker) "[ \t]+\\(.+\\)\\'") line)
    (car (split-string (match-string 1 line) "\t"))))

(defun pi-feedback--compact-magit-file-heading-path (line)
  "Return the path from a compact Magit status file heading LINE."
  (let ((trimmed (string-trim-left line)))
    (when (string-match
           "\\`\\(?:modified\\|new file\\|deleted\\|typechange\\)[ \t]+\\(.+\\)\\'"
           trimmed)
      (string-trim (match-string 1 trimmed)))))

(defun pi-feedback--diff-git-paths (line)
  "Return old/new paths from a diff --git LINE."
  (when (string-match "\\`diff --git[ \t]+\\([^ \t]+\\)[ \t]+\\([^ \t]+\\)" line)
    `((old . ,(match-string 1 line))
      (new . ,(match-string 2 line)))))

(defun pi-feedback--infer-diff-file (old-file new-file diff-old-file diff-new-file)
  "Infer the feedback file path from current diff file headers."
  (or (pi-feedback--strip-diff-prefix new-file)
      (pi-feedback--strip-diff-prefix old-file)
      (pi-feedback--strip-diff-prefix diff-new-file)
      (pi-feedback--strip-diff-prefix diff-old-file)))

(defun pi-feedback--find-diff-context (position)
  "Find the file and hunk context preceding POSITION in a unified diff buffer."
  (save-excursion
    (let (diff-old-file diff-new-file old-file new-file context)
      (goto-char (point-min))
      (while (< (point) position)
        (let ((line-start (point))
              (line (pi-feedback--line-text)))
          (cond
           ((string-prefix-p "diff --git " line)
            (let ((paths (pi-feedback--diff-git-paths line)))
              (setq diff-old-file (alist-get 'old paths)
                    diff-new-file (alist-get 'new paths)
                    old-file nil
                    new-file nil
                    context nil)))
           ((and (not context) (string-prefix-p "--- " line))
            (setq old-file (pi-feedback--diff-file-header-path line "---")
                  context nil))
           ((and (not context) (string-prefix-p "+++ " line))
            (setq new-file (pi-feedback--diff-file-header-path line "+++")
                  context nil))
           ((string-prefix-p "@@" line)
            (let ((hunk (pi-feedback--parse-hunk-header line))
                  (file (pi-feedback--infer-diff-file old-file new-file
                                                      diff-old-file diff-new-file))
                  (body-start (save-excursion
                                (forward-line 1)
                                (point))))
              (setq context `((file . ,file)
                              (hunk . ,hunk)
                              (hunkStart . ,line-start)
                              (bodyStart . ,body-start)))))
           ((string-prefix-p "magit-" (symbol-name major-mode))
            (when-let ((file (pi-feedback--compact-magit-file-heading-path line)))
              (setq old-file file
                    new-file file
                    context nil))))
          (forward-line 1)))
      context)))

(defun pi-feedback--capture-diff-region (project-root feedback)
  "Capture the active Magit/diff region as a feedback note for PROJECT-ROOT."
  (unless (pi-feedback--region-active-p)
    (pi-feedback--diff-selection-user-error))
  (let ((begin (region-beginning))
        (end (region-end))
        (feedback-text (string-trim (or feedback ""))))
    (when (= begin end)
      (pi-feedback--diff-selection-user-error))
    (when (string-empty-p feedback-text)
      (user-error "Feedback text cannot be empty"))
    (let* ((root (pi-feedback--normalize-directory project-root))
           (context (pi-feedback--find-diff-context begin))
           (file (alist-get 'file context))
           (hunk (alist-get 'hunk context))
           (body-start (alist-get 'bodyStart context))
           (selection-line-start (save-excursion
                                   (goto-char begin)
                                   (line-beginning-position))))
      (unless (and context file hunk body-start
                   (<= body-start selection-line-start))
        (pi-feedback--diff-selection-user-error))
      (let ((old-line (alist-get 'oldStart hunk))
            (new-line (alist-get 'newStart hunk))
            old-start old-end new-start new-end
            saw-removed saw-new-side)
        (cl-labels
            ((record-old (line)
               (setq old-start (or old-start line)
                     old-end line))
             (record-new (line)
               (setq new-start (or new-start line)
                     new-end line))
             (consume (kind record)
               (pcase kind
                 ('context
                  (when record
                    (record-old old-line)
                    (record-new new-line)
                    (setq saw-new-side t))
                  (cl-incf old-line)
                  (cl-incf new-line))
                 ('added
                  (when record
                    (record-new new-line)
                    (setq saw-new-side t))
                  (cl-incf new-line))
                 ('removed
                  (when record
                    (record-old old-line)
                    (setq saw-removed t))
                  (cl-incf old-line))
                 ('metadata nil)
                 (_ (pi-feedback--diff-selection-user-error)))))
          (save-excursion
            (goto-char body-start)
            (while (< (point) selection-line-start)
              (consume (pi-feedback--diff-line-kind) nil)
              (forward-line 1))
            (while (< (point) end)
              (consume (pi-feedback--diff-line-kind) t)
              (forward-line 1))))
        (unless (or saw-removed saw-new-side)
          (pi-feedback--diff-selection-user-error))
        (let* ((line-side (cond
                           ((and saw-removed saw-new-side) "mixed")
                           (saw-removed "old")
                           (t "new")))
               (start-line (if new-start new-start old-start))
               (end-line (if new-end new-end old-end))
               (location (pi-feedback--format-diff-location
                          file line-side old-start old-end new-start new-end))
               (absolute-file (expand-file-name file root))
               (quote (buffer-substring-no-properties begin end))
               (created-at (pi-feedback--timestamp))
               (id (pi-feedback--allocate-note-id root)))
          `((id . ,id)
            (file . ,file)
            (absoluteFile . ,absolute-file)
            (startLine . ,start-line)
            (endLine . ,end-line)
            (quote . ,quote)
            (feedback . ,feedback-text)
            (createdAt . ,created-at)
            (source . "diff")
            (location . ,location)
            (lineSide . ,line-side)
            (hunkHeader . ,(alist-get 'header hunk))))))))

(defun pi-feedback--notes (project-root)
  "Return queued notes for PROJECT-ROOT."
  (copy-tree (gethash (pi-feedback--normalize-directory project-root) pi-feedback--queues)))

(defun pi-feedback--valid-note-id-p (id)
  "Return non-nil when ID is a valid local feedback note id."
  (and (integerp id) (> id 0)))

(defun pi-feedback--next-id-after-notes (notes)
  "Return the first positive integer greater than every valid id in NOTES."
  (1+ (cl-loop for note in notes
               for id = (pi-feedback--alist-value 'id note)
               when (pi-feedback--valid-note-id-p id)
               maximize id into maximum
               finally return (or maximum 0))))

(defun pi-feedback--allocate-note-id (project-root)
  "Allocate and return a monotonic local note id for PROJECT-ROOT."
  (let* ((root (pi-feedback--normalize-directory project-root))
         (stored (gethash root pi-feedback--next-ids))
         (stored-next (if (pi-feedback--valid-note-id-p stored) stored 1))
         (queued-next (pi-feedback--next-id-after-notes (gethash root pi-feedback--queues)))
         (id (max 1 stored-next queued-next)))
    (puthash root (1+ id) pi-feedback--next-ids)
    id))

(defun pi-feedback--set-notes (project-root notes)
  "Set queued NOTES for PROJECT-ROOT without lowering its next note id."
  (let ((root (pi-feedback--normalize-directory project-root)))
    (if notes
        (let* ((stored (gethash root pi-feedback--next-ids))
               (stored-next (if (pi-feedback--valid-note-id-p stored) stored 1))
               (next-id (max stored-next (pi-feedback--next-id-after-notes notes))))
          (puthash root (copy-tree notes) pi-feedback--queues)
          (puthash root next-id pi-feedback--next-ids))
      (remhash root pi-feedback--queues))))

(defun pi-feedback--clear-notes (project-root)
  "Clear queued notes and reset local note identity for PROJECT-ROOT."
  (let ((root (pi-feedback--normalize-directory project-root)))
    (remhash root pi-feedback--queues)
    (remhash root pi-feedback--next-ids)))

(defun pi-feedback--renumber-note (note id)
  "Return a copy of NOTE with its local id replaced by ID."
  (let ((copy (copy-tree note)))
    (setf (alist-get 'id copy) id)
    copy))

(defun pi-feedback--bundle (project-root notes)
  "Return a feedback bundle alist for PROJECT-ROOT containing NOTES."
  (let ((root (pi-feedback--normalize-directory project-root)))
    `((version . 1)
      (bundleId . ,(pi-feedback--bundle-id root))
      (projectRoot . ,root)
      (sentAt . ,(pi-feedback--timestamp))
      (source . "emacs")
      (notes . ,(vconcat (cl-loop for note in notes
                                  for id from 1
                                  collect (pi-feedback--renumber-note note id)))))))

(defun pi-feedback--read-json-file (file)
  "Read FILE as a JSON object alist."
  (with-temp-buffer
    (insert-file-contents file)
    (json-parse-buffer :object-type 'alist
                       :array-type 'list
                       :null-object nil
                       :false-object nil)))

(defun pi-feedback--pid-live-p (pid)
  "Return non-nil if PID appears to be live."
  (and (integerp pid)
       (> pid 0)
       (condition-case nil
           (progn
             (signal-process pid 0)
             t)
         (error nil))))

(defun pi-feedback--valid-session-descriptor-p (descriptor)
  "Return non-nil if DESCRIPTOR has the expected v1 shape."
  (and (listp descriptor)
       (equal (pi-feedback--alist-value 'version descriptor) 1)
       (stringp (pi-feedback--alist-value 'sessionId descriptor))
       (stringp (pi-feedback--alist-value 'projectRoot descriptor))
       (stringp (pi-feedback--alist-value 'cwd descriptor))
       (integerp (pi-feedback--alist-value 'pid descriptor))
       (stringp (pi-feedback--alist-value 'inboxPath descriptor))
       (stringp (pi-feedback--alist-value 'startedAt descriptor))
       (or (not (pi-feedback--alist-has-key-p 'sessionName descriptor))
           (stringp (pi-feedback--alist-value 'sessionName descriptor)))))

(defun pi-feedback--session-descriptors ()
  "Return readable session descriptor alists from `pi-feedback-directory'."
  (let ((sessions-dir (expand-file-name "sessions/" pi-feedback-directory)))
    (when (file-directory-p sessions-dir)
      (seq-filter
       #'pi-feedback--valid-session-descriptor-p
       (delq nil
             (mapcar (lambda (file)
                       (condition-case nil
                           (pi-feedback--read-json-file file)
                         (error nil)))
                     (directory-files sessions-dir t "\\.json\\'")))))))

(defun pi-feedback--descriptor-matches-project-root-p (descriptor project-root)
  "Return non-nil when DESCRIPTOR belongs to PROJECT-ROOT.

Pi records both the git toplevel `projectRoot' and the process `cwd'.  Some
Emacs project setups intentionally treat subdirectories as project roots, so a
session also matches when Pi was started inside the Emacs project root."
  (let ((descriptor-root (pi-feedback--alist-value 'projectRoot descriptor))
        (descriptor-cwd (pi-feedback--alist-value 'cwd descriptor))
        (root (pi-feedback--normalize-directory project-root)))
    (condition-case nil
        (or (and (stringp descriptor-root)
                 (equal root (pi-feedback--normalize-directory descriptor-root)))
            (and (stringp descriptor-cwd)
                 (file-in-directory-p (pi-feedback--normalize-directory descriptor-cwd) root)))
      (error nil))))

(defun pi-feedback--matching-sessions (project-root)
  "Return live session descriptors whose project root matches PROJECT-ROOT."
  (seq-filter
   (lambda (descriptor)
     (and (pi-feedback--descriptor-matches-project-root-p descriptor project-root)
          (pi-feedback--pid-live-p (pi-feedback--alist-value 'pid descriptor))))
   (pi-feedback--session-descriptors)))

(defun pi-feedback--normalize-session-name (value)
  "Return VALUE as one trimmed display line, or nil when it is empty."
  (when (stringp value)
    (let ((normalized
           (replace-regexp-in-string "[[:space:]\n\r\t]+" " " (string-trim value))))
      (unless (string-empty-p normalized)
        normalized))))

(defun pi-feedback--path-leaf (directory)
  "Return a compact final component for DIRECTORY, or nil."
  (when (and (stringp directory) (not (string-empty-p directory)))
    (let* ((without-trailing (directory-file-name directory))
           (leaf (file-name-nondirectory without-trailing)))
      (unless (string-empty-p leaf)
        leaf))))

(defun pi-feedback--session-cwd-context (descriptor)
  "Return a compact cwd context for DESCRIPTOR without signaling path errors."
  (let ((project-root (pi-feedback--alist-value 'projectRoot descriptor))
        (cwd (pi-feedback--alist-value 'cwd descriptor)))
    (condition-case nil
        (let* ((root (pi-feedback--normalize-directory project-root))
               (normalized-cwd (pi-feedback--normalize-directory cwd))
               (relative-cwd (file-relative-name normalized-cwd root)))
          (if (and (not (equal root normalized-cwd))
                   (not (file-name-absolute-p relative-cwd))
                   (not (string-prefix-p "../" relative-cwd)))
              (directory-file-name relative-cwd)
            (or (pi-feedback--path-leaf normalized-cwd)
                (pi-feedback--path-leaf root)
                "cwd")))
      (error
       (or (pi-feedback--path-leaf cwd)
           (pi-feedback--path-leaf project-root)
           "cwd")))))

(defun pi-feedback--session-started-label (started-at)
  "Return STARTED-AT in local display time, falling back to stored text."
  (condition-case nil
      (format-time-string "%Y-%m-%d %H:%M"
                          (encode-time (iso8601-parse started-at)))
    (error started-at)))

(defun pi-feedback--session-label (descriptor)
  "Return the human-readable base completion label for DESCRIPTOR."
  (let* ((name (pi-feedback--normalize-session-name
                (pi-feedback--alist-value 'sessionName descriptor)))
         (cwd-context (pi-feedback--session-cwd-context descriptor))
         (started-at (pi-feedback--alist-value 'startedAt descriptor))
         (pid (pi-feedback--alist-value 'pid descriptor)))
    (string-join
     (delq nil
           (list (when name (concat "🪐 " name))
                 cwd-context
                 (format "started %s"
                         (pi-feedback--session-started-label started-at))
                 (format "pid %d" pid)))
     " — ")))

(defun pi-feedback--session-choices (descriptors)
  "Return an explicit completion alist mapping labels to DESCRIPTORS.

Append session id prefixes only when human-readable base labels collide."
  (let ((counts (make-hash-table :test #'equal))
        labeled)
    (dolist (descriptor descriptors)
      (let ((label (pi-feedback--session-label descriptor)))
        (puthash label (1+ (gethash label counts 0)) counts)
        (push (cons label descriptor) labeled)))
    (mapcar
     (lambda (choice)
       (let ((label (car choice))
             (descriptor (cdr choice)))
         (if (> (gethash label counts) 1)
             (let* ((session-id (pi-feedback--alist-value 'sessionId descriptor))
                    (prefix (substring session-id 0 (min 8 (length session-id)))))
               (cons (format "%s — %s" label prefix) descriptor))
           choice)))
     (nreverse labeled))))

(defun pi-feedback--choose-session (project-root)
  "Choose a matching Pi session descriptor for PROJECT-ROOT."
  (let ((matches (pi-feedback--matching-sessions project-root)))
    (pcase (length matches)
      (0 (user-error "No matching terminal Pi session found for %s; start Pi with pi-emacs-feedback from the same project root" project-root))
      (1 (car matches))
      (_ (let* ((choices (pi-feedback--session-choices matches))
                (choice (completing-read "Pi session: " choices nil t)))
           (cdr (assoc choice choices)))))))

(defun pi-feedback--append-bundle (descriptor bundle)
  "Append BUNDLE as one JSONL line to DESCRIPTOR's existing inbox."
  (let ((inbox-path (pi-feedback--alist-value 'inboxPath descriptor)))
    (unless (stringp inbox-path)
      (user-error "Pi session descriptor is missing an inbox path"))
    (unless (file-exists-p inbox-path)
      (user-error "Pi feedback inbox is missing: %s" inbox-path))
    (let ((json-encoding-pretty-print nil)
          (coding-system-for-write 'utf-8-unix))
      (write-region (concat (json-encode bundle) "\n") nil inbox-path 'append 'silent))))

(defun pi-feedback-add ()
  "Capture the active source or Magit/diff region and queue local feedback."
  (interactive)
  (let* ((project-root (pi-feedback--project-root))
         (feedback (read-string "Feedback: "))
         (note (if (and (not buffer-file-name) (pi-feedback--diff-buffer-p))
                   (pi-feedback--capture-diff-region project-root feedback)
                 (pi-feedback--capture-region project-root feedback)))
         (notes (append (pi-feedback--notes project-root) (list note))))
    (pi-feedback--set-notes project-root notes)
    (deactivate-mark)
    (message "Queued %d Emacs feedback note%s"
             (length notes)
             (if (= (length notes) 1) "" "s"))))

(defun pi-feedback--format-note-location (note)
  "Return NOTE's source location string."
  (let ((location (pi-feedback--alist-value 'location note))
        (file (pi-feedback--alist-value 'file note))
        (start-line (pi-feedback--alist-value 'startLine note))
        (end-line (pi-feedback--alist-value 'endLine note)))
    (cond
     ((and (stringp location) (not (string-empty-p (string-trim location))))
      location)
     ((equal start-line end-line)
      (format "%s:%s" file start-line))
     (t
      (format "%s:%s-%s" file start-line end-line)))))

(defvar pi-feedback-list-mode-map
  (let ((map (make-sparse-keymap)))
    (define-key map (kbd "e") #'pi-feedback-edit-at-point)
    (define-key map (kbd "d") #'pi-feedback-remove-at-point)
    (define-key map (kbd "g") #'pi-feedback-list-refresh)
    (define-key map (kbd "q") #'quit-window)
    map)
  "Keymap for `pi-feedback-list-mode'.")

(defvar-local pi-feedback--list-project-root nil
  "Normalized project root rendered by the current feedback list buffer.")

(define-derived-mode pi-feedback-list-mode special-mode "Pi Feedback"
  "Major mode for inspecting and managing queued Emacs feedback notes.")

(defun pi-feedback--insert-note (note)
  "Insert NOTE with its local id as a text property."
  (let ((start (point))
        (id (pi-feedback--alist-value 'id note)))
    (insert (format "Feedback %s (%s)\n"
                    id
                    (pi-feedback--format-note-location note)))
    (insert (format "Created: %s\n" (pi-feedback--alist-value 'createdAt note)))
    (when (pi-feedback--alist-value 'source note)
      (insert (format "Source: %s\n" (pi-feedback--alist-value 'source note))))
    (when (pi-feedback--alist-value 'hunkHeader note)
      (insert (format "Hunk: %s\n" (pi-feedback--alist-value 'hunkHeader note))))
    (insert "\nQuoted selection:\n")
    (insert (pi-feedback--alist-value 'quote note))
    (unless (bolp) (insert "\n"))
    (insert "\nFeedback:\n")
    (insert (pi-feedback--alist-value 'feedback note))
    (insert "\n")
    (add-text-properties start (point) `(pi-feedback-note-id ,id))
    (insert "\n")))

(defun pi-feedback-list-refresh ()
  "Refresh the current feedback list from its authoritative queue."
  (interactive)
  (unless (and (derived-mode-p 'pi-feedback-list-mode)
               pi-feedback--list-project-root)
    (user-error "This is not a Pi feedback list buffer"))
  (let ((notes (pi-feedback--notes pi-feedback--list-project-root))
        (inhibit-read-only t))
    (erase-buffer)
    (insert (format "Emacs feedback for %s\n"
                    pi-feedback--list-project-root))
    (insert "Keys: e: edit  d: remove  g: refresh  q: quit\n\n")
    (if notes
        (dolist (note notes)
          (pi-feedback--insert-note note))
      (insert "No queued Emacs feedback.\n"))
    (goto-char (point-min))))

(defun pi-feedback--current-note-by-id (project-root id &optional notes)
  "Return the queued note with ID for PROJECT-ROOT from NOTES or current state."
  (seq-find (lambda (note)
              (equal (pi-feedback--alist-value 'id note) id))
            (or notes (pi-feedback--notes project-root))))

(defun pi-feedback--note-snapshot-at-point ()
  "Return a defensive copy of the authoritative queued note at point."
  (let ((id (get-text-property (point) 'pi-feedback-note-id)))
    (unless id
      (user-error "Place point inside a queued feedback note"))
    (let ((note (pi-feedback--current-note-by-id
                 pi-feedback--list-project-root id)))
      (unless note
        (user-error "Queued feedback note changed; refresh the list"))
      (copy-tree note))))

(defun pi-feedback-edit-at-point ()
  "Edit only the feedback annotation of the queued note at point."
  (interactive)
  (let* ((root pi-feedback--list-project-root)
         (snapshot (pi-feedback--note-snapshot-at-point))
         (id (pi-feedback--alist-value 'id snapshot))
         (old-feedback (pi-feedback--alist-value 'feedback snapshot))
         (input (read-string "Edit feedback: " old-feedback))
         (feedback (string-trim (or input "")))
         (notes (pi-feedback--notes root))
         (current (pi-feedback--current-note-by-id root id notes)))
    (unless (equal current snapshot)
      (user-error "Queued feedback note changed while editing; refresh and try again"))
    (if (or (string-empty-p feedback)
            (equal feedback old-feedback))
        (message "Kept Emacs feedback note %s unchanged" id)
      (let ((updated
             (mapcar (lambda (note)
                       (if (equal (pi-feedback--alist-value 'id note) id)
                           (let ((copy (copy-tree note)))
                             (setf (alist-get 'feedback copy) feedback)
                             copy)
                         note))
                     notes)))
        (pi-feedback--set-notes root updated)
        (pi-feedback-list-refresh)
        (message "Updated Emacs feedback note %s" id)))))

(defun pi-feedback-remove-at-point ()
  "Confirm and remove the queued feedback note at point."
  (interactive)
  (let* ((root pi-feedback--list-project-root)
         (snapshot (pi-feedback--note-snapshot-at-point))
         (id (pi-feedback--alist-value 'id snapshot))
         (location (pi-feedback--format-note-location snapshot)))
    (if (not (y-or-n-p (format "Remove feedback note %s (%s)? " id location)))
        (message "Kept Emacs feedback note %s" id)
      (let* ((notes (pi-feedback--notes root))
             (current (pi-feedback--current-note-by-id root id notes)))
        (unless (equal current snapshot)
          (user-error "Queued feedback note changed before removal; refresh and try again"))
        (let ((removed nil)
              remaining)
          (dolist (note notes)
            (if (and (not removed)
                     (equal (pi-feedback--alist-value 'id note) id))
                (setq removed t)
              (push note remaining)))
          (pi-feedback--set-notes root (nreverse remaining)))
        (pi-feedback-list-refresh)
        (message "Removed Emacs feedback note %s" id)))))

(defun pi-feedback-list ()
  "Show queued local feedback notes for the current project."
  (interactive)
  (let* ((project-root (pi-feedback--project-root))
         (buffer (get-buffer-create "*pi-feedback*")))
    (with-current-buffer buffer
      (pi-feedback-list-mode)
      (setq-local pi-feedback--list-project-root
                  (pi-feedback--normalize-directory project-root))
      (pi-feedback-list-refresh))
    (pop-to-buffer buffer)
    buffer))

(defun pi-feedback-clear ()
  "Confirm and clear queued local feedback notes for the current project."
  (interactive)
  (let* ((project-root (pi-feedback--project-root))
         (count (length (pi-feedback--notes project-root))))
    (cond
     ((zerop count)
      (message "No queued Emacs feedback to clear"))
     ((y-or-n-p (format "Clear %d queued Emacs feedback note%s? "
                        count
                        (if (= count 1) "" "s")))
      (pi-feedback--clear-notes project-root)
      (message "Cleared %d Emacs feedback note%s"
               count
               (if (= count 1) "" "s")))
     (t
      (message "Kept queued Emacs feedback")))))

(defun pi-feedback-send ()
  "Append queued local feedback to a matching terminal Pi session inbox."
  (interactive)
  (let* ((project-root (pi-feedback--project-root))
         (notes (pi-feedback--notes project-root)))
    (unless notes
      (user-error "No queued Emacs feedback to send"))
    (let* ((descriptor (pi-feedback--choose-session project-root))
           (bundle (pi-feedback--bundle project-root notes))
           (session-id (pi-feedback--alist-value 'sessionId descriptor)))
      (pi-feedback--append-bundle descriptor bundle)
      (pi-feedback--clear-notes project-root)
      (message "Sent %d Emacs feedback note%s to Pi session %s"
               (length notes)
               (if (= (length notes) 1) "" "s")
               (substring session-id 0 (min 8 (length session-id)))))))

(provide 'pi-feedback)

;;; pi-feedback.el ends here
