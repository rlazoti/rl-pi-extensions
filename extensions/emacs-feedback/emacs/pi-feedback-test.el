;;; pi-feedback-test.el --- Tests for pi-feedback.el -*- lexical-binding: t; -*-

;;; Commentary:

;; ERT coverage for the Emacs side of pi-emacs-feedback.

;;; Code:

(require 'cl-lib)
(require 'ert)
(require 'json)
(require 'project)
(require 'seq)
(require 'subr-x)
(require 'diff-mode nil t)
(require 'pi-feedback nil t)

(defun pi-feedback-test--temp-directory ()
  "Return a new temporary directory name with a trailing slash."
  (file-name-as-directory (file-truename (make-temp-file "pi-feedback-test-" t))))

(defmacro pi-feedback-test--with-temp-directory (var &rest body)
  "Bind VAR to a temporary directory while running BODY."
  (declare (indent 1))
  `(let ((,var (pi-feedback-test--temp-directory)))
     (unwind-protect
         (progn ,@body)
       (ignore-errors (delete-directory ,var t)))))

(defmacro pi-feedback-test--with-isolated-state (&rest body)
  "Run BODY with isolated feedback storage and queues."
  (declare (indent 0))
  `(let ((pi-feedback-directory (pi-feedback-test--temp-directory))
         (pi-feedback--queues (make-hash-table :test #'equal))
         (pi-feedback--next-ids (make-hash-table :test #'equal)))
     (unwind-protect
         (progn ,@body)
       (ignore-errors (delete-directory pi-feedback-directory t)))))

(defun pi-feedback-test--write-file (file content)
  "Write CONTENT to FILE, creating parent directories."
  (make-directory (file-name-directory file) t)
  (with-temp-file file
    (insert content)))

(defun pi-feedback-test--read-file (file)
  "Return FILE contents as a string."
  (with-temp-buffer
    (insert-file-contents file)
    (buffer-string)))

(defun pi-feedback-test--write-json-file (file object)
  "Write OBJECT as JSON to FILE."
  (make-directory (file-name-directory file) t)
  (let ((json-encoding-pretty-print nil))
    (with-temp-file file
      (insert (json-encode object)))))

(defun pi-feedback-test--session-file (session-id)
  "Return descriptor path for SESSION-ID in `pi-feedback-directory'."
  (expand-file-name (concat session-id ".json")
                    (expand-file-name "sessions/" pi-feedback-directory)))

(defun pi-feedback-test--override-key (key)
  "Return the alist key represented by KEY."
  (if (keywordp key)
      (intern (substring (symbol-name key) 1))
    key))

(defun pi-feedback-test--descriptor (&rest pairs)
  "Return a session descriptor alist with PAIRS overriding defaults."
  (let ((descriptor (copy-tree '((version . 1)
                                 (sessionId . "session-default")
                                 (projectRoot . "/repo")
                                 (cwd . "/repo")
                                 (pid . 123)
                                 (inboxPath . "/tmp/pi-feedback-inbox.jsonl")
                                 (startedAt . "2026-06-13T00:00:00.000Z")))))
    (while pairs
      (setf (alist-get (pi-feedback-test--override-key (pop pairs)) descriptor) (pop pairs)))
    descriptor))

(defun pi-feedback-test--note (&rest pairs)
  "Return a feedback note alist with PAIRS overriding defaults."
  (let ((note (copy-tree '((id . 1)
                           (file . "src/example.rb")
                           (absoluteFile . "/repo/src/example.rb")
                           (startLine . 2)
                           (endLine . 2)
                           (quote . "beta\n")
                           (feedback . "Please revisit this.")
                           (createdAt . "2026-06-13T00:00:00.000Z")))))
    (while pairs
      (setf (alist-get (pi-feedback-test--override-key (pop pairs)) note) (pop pairs)))
    note))

(defun pi-feedback-test--activate-region (begin end)
  "Activate the region between BEGIN and END in the current buffer."
  (setq-local transient-mark-mode t)
  (goto-char begin)
  (push-mark end t t)
  (activate-mark))

(defmacro pi-feedback-test--with-file-buffer (file content &rest body)
  "Visit FILE containing CONTENT while running BODY, then kill the buffer."
  (declare (indent 2))
  `(progn
     (pi-feedback-test--write-file ,file ,content)
     (let ((buffer (find-file-noselect ,file)))
       (unwind-protect
           (with-current-buffer buffer
             ,@body)
         (when (buffer-live-p buffer)
           (kill-buffer buffer))))))

(defconst pi-feedback-test--sample-diff
  "diff --git a/app/models/foo.rb b/app/models/foo.rb
index 1111111..2222222 100644
--- a/app/models/foo.rb
+++ b/app/models/foo.rb
@@ -10,3 +20,3 @@ def foo
-old one
-old two
+new one
+new two
 unchanged after
@@ -40,1 +50,1 @@ def bar
-old later
+new later
")

(defconst pi-feedback-test--magit-revision-diff
  "commit abc1234
Author: Test User <test@example.com>
Date:   Thu Jun 18 12:00:00 2026 -0500

    Example commit subject

diff --git a/app/models/foo.rb b/app/models/foo.rb
index 1111111..2222222 100644
--- a/app/models/foo.rb
+++ b/app/models/foo.rb
@@ -10,2 +20,2 @@ def foo
-old one
+new one
 unchanged after
")

(defconst pi-feedback-test--compact-magit-status-diff
  "modified   app/models/foo.rb
@@ -10,3 +20,3 @@ def foo
-old one
+new one
 unchanged after
")

(defconst pi-feedback-test--multi-file-compact-magit-status-diff
  "modified   app/models/foo.rb
@@ -10,1 +20,1 @@ def foo
-old one
+new one
modified   app/models/bar.rb
@@ -30,1 +40,1 @@ def bar
-old two
+new two
")

(defconst pi-feedback-test--diff-selection-error
  "Select changed lines inside a single Magit diff hunk before adding Pi feedback.")

(defmacro pi-feedback-test--with-diff-buffer (content &rest body)
  "Create a non-file diff buffer containing CONTENT while running BODY."
  (declare (indent 1))
  `(with-temp-buffer
     (insert ,content)
     (goto-char (point-min))
     (if (fboundp 'diff-mode)
         (diff-mode)
       (setq major-mode 'diff-mode))
     (goto-char (point-min))
     ,@body))

(defun pi-feedback-test--select-text (text)
  "Activate a region around the first occurrence of TEXT in the current buffer."
  (goto-char (point-min))
  (search-forward text)
  (pi-feedback-test--activate-region (- (point) (length text)) (point)))

(defun pi-feedback-test--select-from-text-through-text (start-text end-text)
  "Activate a region from START-TEXT through END-TEXT in the current buffer."
  (goto-char (point-min))
  (search-forward start-text)
  (let ((begin (- (point) (length start-text))))
    (search-forward end-text)
    (pi-feedback-test--activate-region begin (point))))

(defmacro pi-feedback-test--should-diff-user-error (&rest body)
  "Assert BODY signals the standard diff-selection `user-error'."
  (declare (indent 0))
  `(let ((error-data (should-error (progn ,@body) :type 'user-error)))
     (should (string-match-p pi-feedback-test--diff-selection-error
                             (error-message-string error-data)))))

(defun pi-feedback-test--goto-note (id)
  "Move point into the rendered note with ID."
  (let ((position (text-property-any (point-min) (point-max)
                                     'pi-feedback-note-id id)))
    (should position)
    (goto-char position)))

(defmacro pi-feedback-test--with-list-buffer (root notes &rest body)
  "Render NOTES for ROOT and run BODY in the feedback list buffer."
  (declare (indent 2))
  `(let ((default-directory ,root))
     (pi-feedback--set-notes ,root ,notes)
     (cl-letf (((symbol-function 'project-current) (lambda (&rest _args) nil)))
       (pi-feedback-list))
     (unwind-protect
         (with-current-buffer "*pi-feedback*"
           ,@body)
       (when (get-buffer "*pi-feedback*")
         (kill-buffer "*pi-feedback*")))))

(ert-deftest pi-feedback-feature-is-loadable ()
  (should (featurep 'pi-feedback)))

(ert-deftest pi-feedback-alist-value-distinguishes-symbol-key-presence-from-nil ()
  (should-not (pi-feedback--alist-value 'nullable
                                        '((nullable . nil)
                                          ("nullable" . "fallback")))))

(ert-deftest pi-feedback-alist-value-falls-back-to-string-key-when-symbol-absent ()
  (should (equal (pi-feedback--alist-value 'sessionId
                                           '(("sessionId" . "session-string")))
                 "session-string")))

(ert-deftest pi-feedback-normalize-directory-returns-truename-directory ()
  (pi-feedback-test--with-temp-directory root
    (let ((link (directory-file-name (concat root "../pi-feedback-test-link"))))
      (unwind-protect
          (progn
            (make-symbolic-link root link)
            (let ((normalized (pi-feedback--normalize-directory link)))
              (should (equal normalized (file-name-as-directory (file-truename root))))
              (should (string-suffix-p "/" normalized))))
        (ignore-errors (delete-file link))))))

(ert-deftest pi-feedback-project-root-falls-back-to-default-directory ()
  (pi-feedback-test--with-temp-directory root
    (cl-letf (((symbol-function 'project-current) (lambda (&rest _args) nil)))
      (let ((default-directory root))
        (should (equal (pi-feedback--project-root)
                       (pi-feedback--normalize-directory root)))))))

(ert-deftest pi-feedback-descriptor-root-matching-normalizes-truenames ()
  (pi-feedback-test--with-isolated-state
    (pi-feedback-test--with-temp-directory root
      (let ((link (directory-file-name (concat root "../pi-feedback-descriptor-root-link"))))
        (unwind-protect
            (progn
              (make-symbolic-link root link)
              (pi-feedback-test--write-json-file
               (pi-feedback-test--session-file "session-symlink")
               (pi-feedback-test--descriptor :sessionId "session-symlink"
                                             :projectRoot link
                                             :pid 111))
              (cl-letf (((symbol-function 'pi-feedback--pid-live-p) (lambda (_pid) t)))
                (let ((matches (pi-feedback--matching-sessions root)))
                  (should (= (length matches) 1))
                  (should (equal (alist-get 'sessionId (car matches)) "session-symlink")))))
          (ignore-errors (delete-file link)))))))

(ert-deftest pi-feedback-project-root-uses-git-toplevel-from-subdirectory ()
  (skip-unless (executable-find "git"))
  (pi-feedback-test--with-temp-directory root
    (let ((default-directory root))
      (should (zerop (call-process "git" nil nil nil "init"))))
    (let ((subdir (expand-file-name "app/models/" root)))
      (make-directory subdir t)
      (let ((default-directory subdir))
        (should (equal (pi-feedback--project-root)
                       (pi-feedback--normalize-directory root)))))))

(ert-deftest pi-feedback-captures-active-region-from-file-buffer ()
  (pi-feedback-test--with-isolated-state
    (pi-feedback-test--with-temp-directory root
      (let ((file (expand-file-name "src/example.rb" root)))
        (pi-feedback-test--with-file-buffer file "alpha\nbeta\ngamma\n"
          (goto-char (point-min))
          (forward-line 1)
          (let ((begin (point)))
            (forward-line 1)
            (pi-feedback-test--activate-region begin (point)))
          (let ((note (pi-feedback--capture-region root "Please revisit beta.")))
            (should (equal (alist-get 'id note) 1))
            (should (equal (alist-get 'file note) "src/example.rb"))
            (should (equal (alist-get 'absoluteFile note) (file-truename file)))
            (should (equal (alist-get 'startLine note) 2))
            (should (equal (alist-get 'endLine note) 2))
            (should (equal (alist-get 'quote note) "beta\n"))
            (should (equal (alist-get 'feedback note) "Please revisit beta."))
            (should (stringp (alist-get 'createdAt note)))))))))

(ert-deftest pi-feedback-captures-added-diff-lines-with-new-side-location ()
  (pi-feedback-test--with-isolated-state
    (pi-feedback-test--with-temp-directory root
      (pi-feedback-test--with-diff-buffer pi-feedback-test--sample-diff
        (pi-feedback-test--select-text "+new one\n+new two\n")
        (let ((note (pi-feedback--capture-diff-region root "Please revisit these additions.")))
          (should (equal (alist-get 'id note) 1))
          (should (equal (alist-get 'file note) "app/models/foo.rb"))
          (should (equal (alist-get 'absoluteFile note)
                         (expand-file-name "app/models/foo.rb" root)))
          (should (equal (alist-get 'startLine note) 20))
          (should (equal (alist-get 'endLine note) 21))
          (should (equal (alist-get 'quote note) "+new one\n+new two\n"))
          (should (equal (alist-get 'feedback note) "Please revisit these additions."))
          (should (stringp (alist-get 'createdAt note)))
          (should (equal (alist-get 'location note) "app/models/foo.rb:20-21"))
          (should (equal (alist-get 'lineSide note) "new"))
          (should (equal (alist-get 'source note) "diff"))
          (should (equal (alist-get 'hunkHeader note) "@@ -10,3 +20,3 @@ def foo")))))))

(ert-deftest pi-feedback-captures-context-diff-lines-with-new-side-location ()
  (pi-feedback-test--with-isolated-state
    (pi-feedback-test--with-temp-directory root
      (pi-feedback-test--with-diff-buffer pi-feedback-test--sample-diff
        (pi-feedback-test--select-text " unchanged after\n")
        (let ((note (pi-feedback--capture-diff-region root "Context matters here.")))
          (should (equal (alist-get 'file note) "app/models/foo.rb"))
          (should (equal (alist-get 'startLine note) 22))
          (should (equal (alist-get 'endLine note) 22))
          (should (equal (alist-get 'quote note) " unchanged after\n"))
          (should (equal (alist-get 'location note) "app/models/foo.rb:22"))
          (should (equal (alist-get 'lineSide note) "new"))
          (should (equal (alist-get 'source note) "diff")))))))

(ert-deftest pi-feedback-captures-removed-only-diff-lines-with-old-side-location ()
  (pi-feedback-test--with-isolated-state
    (pi-feedback-test--with-temp-directory root
      (pi-feedback-test--with-diff-buffer pi-feedback-test--sample-diff
        (pi-feedback-test--select-text "-old one\n-old two\n")
        (let ((note (pi-feedback--capture-diff-region root "This deletion looks risky.")))
          (should (equal (alist-get 'file note) "app/models/foo.rb"))
          (should (equal (alist-get 'absoluteFile note)
                         (expand-file-name "app/models/foo.rb" root)))
          (should (equal (alist-get 'startLine note) 10))
          (should (equal (alist-get 'endLine note) 11))
          (should (equal (alist-get 'quote note) "-old one\n-old two\n"))
          (should (equal (alist-get 'location note) "app/models/foo.rb:old 10-11"))
          (should (equal (alist-get 'lineSide note) "old"))
          (should (equal (alist-get 'source note) "diff")))))))

(ert-deftest pi-feedback-captures-triple-minus-hunk-line-as-removal ()
  (pi-feedback-test--with-isolated-state
    (pi-feedback-test--with-temp-directory root
      (pi-feedback-test--with-diff-buffer
          "diff --git a/db/query.sql b/db/query.sql
--- a/db/query.sql
+++ b/db/query.sql
@@ -5,1 +5,0 @@
--- SQL comment
"
        (pi-feedback-test--select-text "--- SQL comment\n")
        (let ((note (pi-feedback--capture-diff-region root "SQL comment deletion.")))
          (should (equal (alist-get 'file note) "db/query.sql"))
          (should (equal (alist-get 'absoluteFile note)
                         (expand-file-name "db/query.sql" root)))
          (should (equal (alist-get 'startLine note) 5))
          (should (equal (alist-get 'endLine note) 5))
          (should (equal (alist-get 'quote note) "--- SQL comment\n"))
          (should (equal (alist-get 'location note) "db/query.sql:old 5"))
          (should (equal (alist-get 'lineSide note) "old"))
          (should (equal (alist-get 'source note) "diff")))))))

(ert-deftest pi-feedback-captures-triple-plus-hunk-line-as-addition ()
  (pi-feedback-test--with-isolated-state
    (pi-feedback-test--with-temp-directory root
      (pi-feedback-test--with-diff-buffer
          "diff --git a/src/counter.cpp b/src/counter.cpp
--- a/src/counter.cpp
+++ b/src/counter.cpp
@@ -12,0 +12,1 @@
+++counter
"
        (pi-feedback-test--select-text "+++counter\n")
        (let ((note (pi-feedback--capture-diff-region root "Counter increment addition.")))
          (should (equal (alist-get 'file note) "src/counter.cpp"))
          (should (equal (alist-get 'absoluteFile note)
                         (expand-file-name "src/counter.cpp" root)))
          (should (equal (alist-get 'startLine note) 12))
          (should (equal (alist-get 'endLine note) 12))
          (should (equal (alist-get 'quote note) "+++counter\n"))
          (should (equal (alist-get 'location note) "src/counter.cpp:12"))
          (should (equal (alist-get 'lineSide note) "new"))
          (should (equal (alist-get 'source note) "diff")))))))

(ert-deftest pi-feedback-captures-line-after-triple-plus-hunk-content ()
  (pi-feedback-test--with-isolated-state
    (pi-feedback-test--with-temp-directory root
      (pi-feedback-test--with-diff-buffer
          "diff --git a/src/counter.cpp b/src/counter.cpp
--- a/src/counter.cpp
+++ b/src/counter.cpp
@@ -12,0 +12,2 @@
+++counter
+next line
"
        (pi-feedback-test--select-text "+next line\n")
        (let ((note (pi-feedback--capture-diff-region root "Next line addition.")))
          (should (equal (alist-get 'file note) "src/counter.cpp"))
          (should (equal (alist-get 'startLine note) 13))
          (should (equal (alist-get 'endLine note) 13))
          (should (equal (alist-get 'quote note) "+next line\n"))
          (should (equal (alist-get 'location note) "src/counter.cpp:13"))
          (should (equal (alist-get 'lineSide note) "new")))))))

(ert-deftest pi-feedback-captures-line-after-triple-minus-hunk-content ()
  (pi-feedback-test--with-isolated-state
    (pi-feedback-test--with-temp-directory root
      (pi-feedback-test--with-diff-buffer
          "diff --git a/db/query.sql b/db/query.sql
--- a/db/query.sql
+++ b/db/query.sql
@@ -5,2 +5,0 @@
--- SQL comment
-next line
"
        (pi-feedback-test--select-text "-next line\n")
        (let ((note (pi-feedback--capture-diff-region root "Next line removal.")))
          (should (equal (alist-get 'file note) "db/query.sql"))
          (should (equal (alist-get 'startLine note) 6))
          (should (equal (alist-get 'endLine note) 6))
          (should (equal (alist-get 'quote note) "-next line\n"))
          (should (equal (alist-get 'location note) "db/query.sql:old 6"))
          (should (equal (alist-get 'lineSide note) "old")))))))

(ert-deftest pi-feedback-captures-mixed-diff-lines-with-old-and-new-location ()
  (pi-feedback-test--with-isolated-state
    (pi-feedback-test--with-temp-directory root
      (pi-feedback-test--with-diff-buffer pi-feedback-test--sample-diff
        (pi-feedback-test--select-text "-old one\n-old two\n+new one\n+new two\n")
        (let ((note (pi-feedback--capture-diff-region root "Compare both sides.")))
          (should (equal (alist-get 'file note) "app/models/foo.rb"))
          (should (equal (alist-get 'startLine note) 20))
          (should (equal (alist-get 'endLine note) 21))
          (should (equal (alist-get 'quote note) "-old one\n-old two\n+new one\n+new two\n"))
          (should (equal (alist-get 'location note)
                         "app/models/foo.rb:mixed old 10-11 / new 20-21"))
          (should (equal (alist-get 'lineSide note) "mixed"))
          (should (equal (alist-get 'source note) "diff")))))))

(ert-deftest pi-feedback-captures-deleted-file-diff-lines-using-old-path ()
  (pi-feedback-test--with-isolated-state
    (pi-feedback-test--with-temp-directory root
      (pi-feedback-test--with-diff-buffer
          "diff --git a/app/models/foo.rb b/app/models/foo.rb
--- a/app/models/foo.rb
+++ /dev/null
@@ -10,2 +0,0 @@ def foo
-old one
-old two
"
        (pi-feedback-test--select-text "-old one\n-old two\n")
        (let ((note (pi-feedback--capture-diff-region root "Deleted file still needs a path.")))
          (should (equal (alist-get 'file note) "app/models/foo.rb"))
          (should (equal (alist-get 'absoluteFile note)
                         (expand-file-name "app/models/foo.rb" root)))
          (should (equal (alist-get 'startLine note) 10))
          (should (equal (alist-get 'endLine note) 11))
          (should (equal (alist-get 'location note) "app/models/foo.rb:old 10-11"))
          (should (equal (alist-get 'lineSide note) "old")))))))

(ert-deftest pi-feedback-captures-diff-lines-using-diff-git-path-fallback ()
  (pi-feedback-test--with-isolated-state
    (pi-feedback-test--with-temp-directory root
      (pi-feedback-test--with-diff-buffer
          "diff --git a/app/models/foo.rb b/app/models/foo.rb
@@ -10,1 +20,1 @@ def foo
-old one
+new one
"
        (pi-feedback-test--select-text "+new one\n")
        (let ((note (pi-feedback--capture-diff-region root "Fallback path.")))
          (should (equal (alist-get 'file note) "app/models/foo.rb"))
          (should (equal (alist-get 'absoluteFile note)
                         (expand-file-name "app/models/foo.rb" root)))
          (should (equal (alist-get 'location note) "app/models/foo.rb:20"))
          (should (equal (alist-get 'lineSide note) "new")))))))

(ert-deftest pi-feedback-captures-magit-revision-diff-lines ()
  (pi-feedback-test--with-isolated-state
    (pi-feedback-test--with-temp-directory root
      (pi-feedback-test--with-diff-buffer pi-feedback-test--magit-revision-diff
        (setq major-mode 'magit-revision-mode)
        (pi-feedback-test--select-text "+new one\n")
        (let ((note (pi-feedback--capture-diff-region root "Revision diff note.")))
          (should (equal (alist-get 'source note) "diff"))
          (should (equal (alist-get 'file note) "app/models/foo.rb"))
          (should (equal (alist-get 'location note) "app/models/foo.rb:20"))
          (should (equal (alist-get 'lineSide note) "new")))))))

(ert-deftest pi-feedback-magit-revision-errors-in-commit-metadata ()
  (pi-feedback-test--with-isolated-state
    (pi-feedback-test--with-temp-directory root
      (pi-feedback-test--with-diff-buffer pi-feedback-test--magit-revision-diff
        (setq major-mode 'magit-revision-mode)
        (pi-feedback-test--select-text "Example commit subject\n")
        (pi-feedback-test--should-diff-user-error
          (pi-feedback--capture-diff-region root "Metadata note."))))))

(ert-deftest pi-feedback-captures-compact-magit-status-diff-lines ()
  (pi-feedback-test--with-isolated-state
    (pi-feedback-test--with-temp-directory root
      (pi-feedback-test--with-diff-buffer pi-feedback-test--compact-magit-status-diff
        (setq major-mode 'magit-status-mode)
        (pi-feedback-test--select-text "+new one\n")
        (let ((note (pi-feedback--capture-diff-region root "Compact Magit status diff.")))
          (should (equal (alist-get 'source note) "diff"))
          (should (equal (alist-get 'file note) "app/models/foo.rb"))
          (should (equal (alist-get 'location note) "app/models/foo.rb:20"))
          (should (equal (alist-get 'lineSide note) "new")))))))

(ert-deftest pi-feedback-captures-second-compact-magit-status-file ()
  (pi-feedback-test--with-isolated-state
    (pi-feedback-test--with-temp-directory root
      (pi-feedback-test--with-diff-buffer pi-feedback-test--multi-file-compact-magit-status-diff
        (setq major-mode 'magit-status-mode)
        (pi-feedback-test--select-text "+new two\n")
        (let ((note (pi-feedback--capture-diff-region root "Second compact Magit file.")))
          (should (equal (alist-get 'file note) "app/models/bar.rb"))
          (should (equal (alist-get 'location note) "app/models/bar.rb:40")))))))

(ert-deftest pi-feedback-diff-capture-errors-outside-a-hunk ()
  (pi-feedback-test--with-isolated-state
    (pi-feedback-test--with-temp-directory root
      (pi-feedback-test--with-diff-buffer pi-feedback-test--sample-diff
        (pi-feedback-test--select-text "index 1111111..2222222 100644\n")
        (pi-feedback-test--should-diff-user-error
          (pi-feedback--capture-diff-region root "No hunk here."))))))

(ert-deftest pi-feedback-diff-capture-errors-when-region-spans-two-hunks ()
  (pi-feedback-test--with-isolated-state
    (pi-feedback-test--with-temp-directory root
      (pi-feedback-test--with-diff-buffer pi-feedback-test--sample-diff
        (pi-feedback-test--select-from-text-through-text "+new two\n" "+new later\n")
        (pi-feedback-test--should-diff-user-error
          (pi-feedback--capture-diff-region root "Too wide."))))))

(ert-deftest pi-feedback-diff-capture-errors-when-region-spans-two-files ()
  (pi-feedback-test--with-isolated-state
    (pi-feedback-test--with-temp-directory root
      (pi-feedback-test--with-diff-buffer
          "diff --git a/app/models/foo.rb b/app/models/foo.rb
--- a/app/models/foo.rb
+++ b/app/models/foo.rb
@@ -1,1 +1,1 @@
-old
+new

diff --git a/app/models/bar.rb b/app/models/bar.rb
--- a/app/models/bar.rb
+++ b/app/models/bar.rb
@@ -5,1 +5,1 @@
-old bar
+new bar
"
        (pi-feedback-test--select-from-text-through-text "+new\n" "+new bar\n")
        (pi-feedback-test--should-diff-user-error
          (pi-feedback--capture-diff-region root "Too many files."))))))

(ert-deftest pi-feedback-diff-capture-errors-when-region-is-only-metadata ()
  (pi-feedback-test--with-isolated-state
    (pi-feedback-test--with-temp-directory root
      (pi-feedback-test--with-diff-buffer pi-feedback-test--sample-diff
        (pi-feedback-test--select-text "@@ -10,3 +20,3 @@ def foo\n")
        (pi-feedback-test--should-diff-user-error
          (pi-feedback--capture-diff-region root "No changed lines."))))))

(ert-deftest pi-feedback-diff-capture-errors-with-no-active-region ()
  (pi-feedback-test--with-isolated-state
    (pi-feedback-test--with-temp-directory root
      (pi-feedback-test--with-diff-buffer pi-feedback-test--sample-diff
        (deactivate-mark)
        (pi-feedback-test--should-diff-user-error
          (pi-feedback--capture-diff-region root "No region."))))))

(ert-deftest pi-feedback-diff-capture-errors-with-empty-active-region ()
  (pi-feedback-test--with-isolated-state
    (pi-feedback-test--with-temp-directory root
      (pi-feedback-test--with-diff-buffer pi-feedback-test--sample-diff
        (pi-feedback-test--activate-region (point-min) (point-min))
        (pi-feedback-test--should-diff-user-error
          (pi-feedback--capture-diff-region root "Empty region."))))))

(ert-deftest pi-feedback-diff-capture-errors-when-hunk-has-no-inferable-file-path ()
  (pi-feedback-test--with-isolated-state
    (pi-feedback-test--with-temp-directory root
      (pi-feedback-test--with-diff-buffer
          "@@ -1,1 +1,1 @@
-old
+new
"
        (pi-feedback-test--select-text "+new\n")
        (pi-feedback-test--should-diff-user-error
          (pi-feedback--capture-diff-region root "No file path."))))))

(ert-deftest pi-feedback-diff-capture-errors-with-empty-feedback ()
  (pi-feedback-test--with-isolated-state
    (pi-feedback-test--with-temp-directory root
      (pi-feedback-test--with-diff-buffer pi-feedback-test--sample-diff
        (pi-feedback-test--select-text "+new one\n")
        (should-error (pi-feedback--capture-diff-region root "   ") :type 'user-error)))))

(ert-deftest pi-feedback-diff-buffer-p-detects-supported-diff-modes ()
  (dolist (mode '(diff-mode magit-diff-mode magit-status-mode magit-revision-mode))
    (with-temp-buffer
      (setq major-mode mode)
      (should (pi-feedback--diff-buffer-p))))
  (with-temp-buffer
    (setq major-mode 'fundamental-mode)
    (should-not (pi-feedback--diff-buffer-p))))

(ert-deftest pi-feedback-strip-diff-prefix-strips-git-sides-and-skips-dev-null ()
  (should (equal (pi-feedback--strip-diff-prefix "a/app/models/foo.rb") "app/models/foo.rb"))
  (should (equal (pi-feedback--strip-diff-prefix "b/app/models/foo.rb") "app/models/foo.rb"))
  (should (equal (pi-feedback--strip-diff-prefix "app/models/foo.rb") "app/models/foo.rb"))
  (should-not (pi-feedback--strip-diff-prefix "/dev/null")))

(ert-deftest pi-feedback-parse-hunk-header-parses-ranges-and-default-counts ()
  (let ((parsed (pi-feedback--parse-hunk-header "@@ -10,2 +20 @@ optional context")))
    (should (equal (alist-get 'oldStart parsed) 10))
    (should (equal (alist-get 'oldCount parsed) 2))
    (should (equal (alist-get 'newStart parsed) 20))
    (should (equal (alist-get 'newCount parsed) 1))
    (should (equal (alist-get 'header parsed) "@@ -10,2 +20 @@ optional context"))))

(ert-deftest pi-feedback-diff-line-kind-classifies-triple-minus-content-as-removed ()
  (with-temp-buffer
    (insert "--- SQL comment\n")
    (goto-char (point-min))
    (should (eq (pi-feedback--diff-line-kind) 'removed))))

(ert-deftest pi-feedback-diff-line-kind-classifies-triple-plus-content-as-added ()
  (with-temp-buffer
    (insert "+++counter\n")
    (goto-char (point-min))
    (should (eq (pi-feedback--diff-line-kind) 'added))))

(ert-deftest pi-feedback-capture-errors-for-invalid-inputs ()
  (pi-feedback-test--with-isolated-state
    (pi-feedback-test--with-temp-directory root
      (let ((file (expand-file-name "src/example.rb" root))
            (outside (expand-file-name "outside.rb" (pi-feedback-test--temp-directory))))
        (unwind-protect
            (progn
              (pi-feedback-test--with-file-buffer file "alpha\n"
                (goto-char (point-min))
                (deactivate-mark)
                (should-error (pi-feedback--capture-region root "feedback") :type 'user-error))
              (pi-feedback-test--with-file-buffer file "alpha\n"
                (pi-feedback-test--activate-region (point-min) (point-min))
                (should-error (pi-feedback--capture-region root "feedback") :type 'user-error))
              (with-temp-buffer
                (insert "alpha")
                (pi-feedback-test--activate-region (point-min) (point-max))
                (should-error (pi-feedback--capture-region root "feedback") :type 'user-error))
              (pi-feedback-test--with-file-buffer outside "alpha\n"
                (pi-feedback-test--activate-region (point-min) (point-max))
                (should-error (pi-feedback--capture-region root "feedback") :type 'user-error))
              (pi-feedback-test--with-file-buffer file "alpha\n"
                (pi-feedback-test--activate-region (point-min) (point-max))
                (should-error (pi-feedback--capture-region root "   ") :type 'user-error)))
          (ignore-errors (delete-directory (file-name-directory outside) t)))))))

(ert-deftest pi-feedback-add-queues-note-and-deactivates-mark-after-success ()
  (pi-feedback-test--with-isolated-state
    (pi-feedback-test--with-temp-directory root
      (let ((file (expand-file-name "src/example.rb" root))
            (default-directory root))
        (pi-feedback-test--with-file-buffer file "alpha\nbeta\ngamma\n"
          (goto-char (point-min))
          (forward-line 1)
          (let ((begin (point)))
            (forward-line 1)
            (pi-feedback-test--activate-region begin (point)))
          (cl-letf (((symbol-function 'pi-feedback--project-root)
                     (lambda () (pi-feedback--normalize-directory root)))
                    ((symbol-function 'read-string) (lambda (&rest _args) "Queue this note.")))
            (pi-feedback-add))
          (should-not (region-active-p))
          (let ((notes (pi-feedback--notes root)))
            (should (= (length notes) 1))
            (should (equal (alist-get 'feedback (car notes)) "Queue this note."))))))))

(ert-deftest pi-feedback-add-errors-in-non-file-non-diff-buffer-with-helpful-message ()
  (pi-feedback-test--with-isolated-state
    (pi-feedback-test--with-temp-directory root
      (with-temp-buffer
        (fundamental-mode)
        (insert "scratch feedback target")
        (pi-feedback-test--activate-region (point-min) (point-max))
        (cl-letf (((symbol-function 'pi-feedback--project-root)
                   (lambda () (pi-feedback--normalize-directory root)))
                  ((symbol-function 'read-string) (lambda (&rest _args) "Queue this note.")))
          (let* ((error-data (should-error (pi-feedback-add) :type 'user-error))
                 (message (error-message-string error-data)))
            (should (string-match-p "source file" message))
            (should (string-match-p "Magit/diff" message))))))))

(ert-deftest pi-feedback-add-queues-diff-note-from-diff-buffer ()
  (pi-feedback-test--with-isolated-state
    (pi-feedback-test--with-temp-directory root
      (pi-feedback-test--with-diff-buffer pi-feedback-test--sample-diff
        (pi-feedback-test--select-text "+new one\n")
        (cl-letf (((symbol-function 'pi-feedback--project-root)
                   (lambda () (pi-feedback--normalize-directory root)))
                  ((symbol-function 'read-string) (lambda (&rest _args) "Queue diff note.")))
          (pi-feedback-add))
        (let ((notes (pi-feedback--notes root)))
          (should (= (length notes) 1))
          (let ((note (car notes)))
            (should (equal (alist-get 'source note) "diff"))
            (should (equal (alist-get 'lineSide note) "new"))
            (should (equal (alist-get 'location note) "app/models/foo.rb:20"))))))))

(ert-deftest pi-feedback-add-queues-note-from-magit-revision-buffer ()
  (pi-feedback-test--with-isolated-state
    (pi-feedback-test--with-temp-directory root
      (pi-feedback-test--with-diff-buffer pi-feedback-test--magit-revision-diff
        (setq major-mode 'magit-revision-mode)
        (pi-feedback-test--select-text "+new one\n")
        (cl-letf (((symbol-function 'pi-feedback--project-root)
                   (lambda () (pi-feedback--normalize-directory root)))
                  ((symbol-function 'read-string) (lambda (&rest _args) "Queue revision note.")))
          (pi-feedback-add))
        (let ((notes (pi-feedback--notes root)))
          (should (= (length notes) 1))
          (let ((note (car notes)))
            (should (equal (alist-get 'source note) "diff"))
            (should (equal (alist-get 'location note) "app/models/foo.rb:20"))))))))

(ert-deftest pi-feedback-local-note-queues-are-per-project-and-clearable ()
  (pi-feedback-test--with-isolated-state
    (pi-feedback-test--with-temp-directory root-a
      (pi-feedback-test--with-temp-directory root-b
        (pi-feedback--set-notes root-a (list (pi-feedback-test--note :feedback "A")))
        (pi-feedback--set-notes root-b (list (pi-feedback-test--note :feedback "B")))
        (should (equal (alist-get 'feedback (car (pi-feedback--notes root-a))) "A"))
        (should (equal (alist-get 'feedback (car (pi-feedback--notes root-b))) "B"))
        (pi-feedback--clear-notes root-a)
        (should-not (pi-feedback--notes root-a))
        (should (equal (alist-get 'feedback (car (pi-feedback--notes root-b))) "B"))))))

(ert-deftest pi-feedback-session-descriptor-accepts-absent-session-name ()
  (should (pi-feedback--valid-session-descriptor-p
           (pi-feedback-test--descriptor))))

(ert-deftest pi-feedback-session-descriptor-accepts-string-session-name ()
  (should (pi-feedback--valid-session-descriptor-p
           (pi-feedback-test--descriptor :sessionName "Plan ACH migration"))))

(ert-deftest pi-feedback-session-descriptor-rejects-non-string-session-name ()
  (should-not (pi-feedback--valid-session-descriptor-p
               (pi-feedback-test--descriptor :sessionName 123))))

(ert-deftest pi-feedback-session-descriptor-rejects-null-session-name ()
  (should-not (pi-feedback--valid-session-descriptor-p
               (pi-feedback-test--descriptor :sessionName nil))))

(ert-deftest pi-feedback-session-label-leads-with-normalized-name-and-orders-context ()
  (let* ((started-at "2026-07-16T20:32:00.000Z")
         (descriptor (pi-feedback-test--descriptor
                      :sessionName "Plan ACH same-day migration"
                      :projectRoot "/work/banking"
                      :cwd "/work/banking"
                      :pid 12345
                      :startedAt started-at))
         (local-time (format-time-string "%Y-%m-%d %H:%M"
                                         (date-to-time started-at))))
    (should (equal (pi-feedback--session-label descriptor)
                   (format "🪐 Plan ACH same-day migration — banking — started %s — pid 12345"
                           local-time)))))

(ert-deftest pi-feedback-session-label-normalizes-multiline-name ()
  (let ((label (pi-feedback--session-label
                (pi-feedback-test--descriptor
                 :sessionName "  Plan ACH\n same-day\t migration  "
                 :projectRoot "/work/banking"
                 :cwd "/work/banking"))))
    (should (string-prefix-p "🪐 Plan ACH same-day migration — banking — " label))
    (should-not (string-match-p "[\n\t]" label))))

(ert-deftest pi-feedback-session-label-uses-cwd-when-name-is-whitespace ()
  (let ((label (pi-feedback--session-label
                (pi-feedback-test--descriptor
                 :sessionName " \n\t "
                 :projectRoot "/work/banking"
                 :cwd "/work/banking"))))
    (should (string-prefix-p "banking — started " label))
    (should-not (string-match-p "🪐" label))))

(ert-deftest pi-feedback-session-label-uses-relative-nested-cwd-context ()
  (let ((label (pi-feedback--session-label
                (pi-feedback-test--descriptor
                 :projectRoot "/work"
                 :cwd "/work/src/areas/banking"))))
    (should (string-prefix-p "src/areas/banking — started " label))))

(ert-deftest pi-feedback-session-label-falls-back-when-path-normalization-errors ()
  (cl-letf (((symbol-function 'pi-feedback--normalize-directory)
             (lambda (_directory) (error "normalization failed"))))
    (should (string-prefix-p
             "banking — started "
             (pi-feedback--session-label
              (pi-feedback-test--descriptor
               :projectRoot "/work"
               :cwd "/work/banking"))))))

(ert-deftest pi-feedback-session-label-falls-back-to-invalid-started-text ()
  (should (string-match-p
           (regexp-quote " — started not-a-time — pid 123")
           (pi-feedback--session-label
            (pi-feedback-test--descriptor
             :projectRoot "/work/banking"
             :cwd "/work/banking"
             :startedAt "not-a-time")))))

(ert-deftest pi-feedback-session-choices-suffix-only-colliding-labels ()
  (let* ((first (pi-feedback-test--descriptor
                 :sessionId "aaaaaaaa-first"
                 :sessionName "Same"
                 :projectRoot "/work/banking"
                 :cwd "/work/banking"
                 :pid 111))
         (second (pi-feedback-test--descriptor
                  :sessionId "bbbbbbbb-second"
                  :sessionName "Same"
                  :projectRoot "/work/banking"
                  :cwd "/work/banking"
                  :pid 111))
         (unique (pi-feedback-test--descriptor
                  :sessionId "cccccccc-unique"
                  :sessionName "Unique"
                  :projectRoot "/work/banking"
                  :cwd "/work/banking"
                  :pid 222))
         (choices (pi-feedback--session-choices (list first second unique)))
         (labels (mapcar #'car choices)))
    (should (string-suffix-p " — aaaaaaaa" (nth 0 labels)))
    (should (string-suffix-p " — bbbbbbbb" (nth 1 labels)))
    (should-not (string-match-p "cccccccc" (nth 2 labels)))
    (should (eq (cdar choices) first))
    (should (eq (cdr (nth 1 choices)) second))
    (should (eq (cdr (nth 2 choices)) unique))))

(ert-deftest pi-feedback-session-filtering-keeps-matching-root-and-live-pid ()
  (pi-feedback-test--with-isolated-state
    (pi-feedback-test--with-temp-directory root
      (pi-feedback-test--with-temp-directory other-root
        (pi-feedback-test--write-json-file
         (pi-feedback-test--session-file "live-match")
         (pi-feedback-test--descriptor :sessionId "live-match" :projectRoot root :pid 111))
        (pi-feedback-test--write-json-file
         (pi-feedback-test--session-file "dead-match")
         (pi-feedback-test--descriptor :sessionId "dead-match" :projectRoot root :pid 222))
        (pi-feedback-test--write-json-file
         (pi-feedback-test--session-file "live-other")
         (pi-feedback-test--descriptor :sessionId "live-other" :projectRoot other-root :pid 333))
        (pi-feedback-test--write-file (pi-feedback-test--session-file "malformed") "{")
        (cl-letf (((symbol-function 'pi-feedback--pid-live-p) (lambda (pid) (= pid 111))))
          (let ((matches (pi-feedback--matching-sessions root)))
            (should (= (length matches) 1))
            (should (equal (alist-get 'sessionId (car matches)) "live-match"))))))))

(ert-deftest pi-feedback-session-filtering-matches-pi-cwd-inside-emacs-project-root ()
  (pi-feedback-test--with-isolated-state
    (pi-feedback-test--with-temp-directory git-root
      (let* ((emacs-root (expand-file-name "src/areas/platforms/banking/" git-root))
             (descriptor (pi-feedback-test--descriptor
                          :sessionId "cwd-match"
                          :projectRoot git-root
                          :cwd emacs-root
                          :pid 111)))
        (make-directory emacs-root t)
        (pi-feedback-test--write-json-file
         (pi-feedback-test--session-file "cwd-match")
         descriptor)
        (cl-letf (((symbol-function 'pi-feedback--pid-live-p) (lambda (pid) (= pid 111))))
          (let ((matches (pi-feedback--matching-sessions emacs-root)))
            (should (= (length matches) 1))
            (should (equal (alist-get 'sessionId (car matches)) "cwd-match"))))))))

(ert-deftest pi-feedback-choose-session-errors-when-no-session-matches ()
  (cl-letf (((symbol-function 'pi-feedback--matching-sessions) (lambda (_root) nil)))
    (should-error (pi-feedback--choose-session "/repo/") :type 'user-error)))

(ert-deftest pi-feedback-choose-session-prompts-with-human-label-and-maps-exact-choice ()
  (let* ((first (pi-feedback-test--descriptor :sessionId "first-session-id"
                                              :sessionName "First plan"
                                              :pid 111
                                              :startedAt "2026-06-13T00:00:00.000Z"))
         (second (pi-feedback-test--descriptor :sessionId "second-session-id"
                                               :sessionName "Second plan"
                                               :pid 222
                                               :startedAt "2026-06-13T00:01:00.000Z"))
         (called nil)
         (completion-choices nil))
    (cl-letf (((symbol-function 'pi-feedback--matching-sessions) (lambda (_root) (list first second)))
              ((symbol-function 'completing-read)
               (lambda (_prompt collection &rest _args)
                 (setq called t)
                 (setq completion-choices collection)
                 (let ((label (car (rassq second collection))))
                   (should (string-prefix-p "🪐 Second plan — repo — started " label))
                   label))))
      (should (eq (pi-feedback--choose-session "/repo/") second))
      (should called)
      (should (= (length completion-choices) 2))
      (should (equal (mapcar #'cdr completion-choices) (list first second))))))

(ert-deftest pi-feedback-bundle-json-has-metadata-and-renumbered-notes ()
  (pi-feedback-test--with-temp-directory root
    (let* ((notes (list (pi-feedback-test--note :id 7 :feedback "First")
                        (pi-feedback-test--note :id 42 :feedback "Second")))
           (bundle (pi-feedback--bundle root notes))
           (bundled-notes (alist-get 'notes bundle)))
      (should (equal (alist-get 'version bundle) 1))
      (should (stringp (alist-get 'bundleId bundle)))
      (should (equal (alist-get 'projectRoot bundle) (pi-feedback--normalize-directory root)))
      (should (stringp (alist-get 'sentAt bundle)))
      (should (equal (alist-get 'source bundle) "emacs"))
      (should (vectorp bundled-notes))
      (should (= (length bundled-notes) 2))
      (should (equal (alist-get 'id (aref bundled-notes 0)) 1))
      (should (equal (alist-get 'id (aref bundled-notes 1)) 2))
      (should (json-parse-string (json-encode bundle) :object-type 'alist :array-type 'list)))))

(ert-deftest pi-feedback-bundle-json-preserves-diff-note-metadata ()
  (pi-feedback-test--with-temp-directory root
    (let* ((note (pi-feedback-test--note :id 7
                                         :source "diff"
                                         :location "app/models/foo.rb:old 10-11"
                                         :lineSide "old"
                                         :hunkHeader "@@ -10,3 +20,3 @@ def foo"))
           (bundle (pi-feedback--bundle root (list note)))
           (parsed (json-parse-string (json-encode bundle)
                                      :object-type 'alist
                                      :array-type 'list))
           (parsed-note (car (alist-get 'notes parsed))))
      (should (equal (alist-get 'id parsed-note) 1))
      (should (equal (alist-get 'source parsed-note) "diff"))
      (should (equal (alist-get 'location parsed-note) "app/models/foo.rb:old 10-11"))
      (should (equal (alist-get 'lineSide parsed-note) "old"))
      (should (equal (alist-get 'hunkHeader parsed-note) "@@ -10,3 +20,3 @@ def foo")))))

(ert-deftest pi-feedback-append-bundle-appends-jsonl-to-existing-inbox ()
  (pi-feedback-test--with-temp-directory root
    (let* ((inbox (expand-file-name "inbox.jsonl" root))
           (descriptor (pi-feedback-test--descriptor :inboxPath inbox))
           (bundle (pi-feedback--bundle root (list (pi-feedback-test--note)))))
      (pi-feedback-test--write-file inbox "{\"existing\":true}\n")
      (pi-feedback--append-bundle descriptor bundle)
      (let* ((lines (split-string (pi-feedback-test--read-file inbox) "\n" t))
             (appended (json-parse-string (cadr lines) :object-type 'alist :array-type 'list)))
        (should (= (length lines) 2))
        (should (equal (alist-get 'bundleId appended) (alist-get 'bundleId bundle)))))))

(ert-deftest pi-feedback-append-bundle-errors-when-inbox-is-missing ()
  (pi-feedback-test--with-temp-directory root
    (let* ((missing (expand-file-name "missing.jsonl" root))
           (descriptor (pi-feedback-test--descriptor :inboxPath missing)))
      (should-error (pi-feedback--append-bundle descriptor '((version . 1))) :type 'user-error)
      (should-not (file-exists-p missing)))))

(ert-deftest pi-feedback-send-appends-bundle-and-clears-local-notes-after-success ()
  (pi-feedback-test--with-isolated-state
    (pi-feedback-test--with-temp-directory root
      (let* ((inbox (expand-file-name "inbox.jsonl" root))
             (descriptor (pi-feedback-test--descriptor :sessionId "session-send-success"
                                                       :projectRoot root
                                                       :cwd root
                                                       :inboxPath inbox))
             (default-directory root))
        (pi-feedback-test--write-file inbox "{\"existing\":true}\n")
        (pi-feedback--set-notes root (list (pi-feedback-test--note :feedback "Ship this note.")))
        (cl-letf (((symbol-function 'project-current) (lambda (&rest _args) nil))
                  ((symbol-function 'pi-feedback--choose-session)
                   (lambda (project-root)
                     (should (equal project-root (pi-feedback--normalize-directory root)))
                     descriptor)))
          (pi-feedback-send))
        (should-not (pi-feedback--notes root))
        (should-not (gethash (pi-feedback--normalize-directory root)
                             pi-feedback--next-ids))
        (let* ((lines (split-string (pi-feedback-test--read-file inbox) "\n" t))
               (appended (json-parse-string (cadr lines) :object-type 'alist :array-type 'list))
               (notes (alist-get 'notes appended)))
          (should (= (length lines) 2))
          (should (equal (alist-get 'source appended) "emacs"))
          (should (= (length notes) 1))
          (should (equal (alist-get 'feedback (car notes)) "Ship this note.")))))))

(ert-deftest pi-feedback-send-keeps-local-notes-when-inbox-is-missing ()
  (pi-feedback-test--with-isolated-state
    (pi-feedback-test--with-temp-directory root
      (let* ((missing (expand-file-name "missing.jsonl" root))
             (descriptor (pi-feedback-test--descriptor :sessionId "session-send-missing"
                                                       :projectRoot root
                                                       :cwd root
                                                       :inboxPath missing))
             (default-directory root))
        (pi-feedback--set-notes root (list (pi-feedback-test--note :feedback "Keep this note.")))
        (cl-letf (((symbol-function 'project-current) (lambda (&rest _args) nil))
                  ((symbol-function 'pi-feedback--choose-session) (lambda (_project-root) descriptor)))
          (should-error (pi-feedback-send) :type 'user-error))
        (let ((notes (pi-feedback--notes root)))
          (should (= (length notes) 1))
          (should (equal (alist-get 'feedback (car notes)) "Keep this note.")))
        (should-not (file-exists-p missing))))))

(ert-deftest pi-feedback-format-note-location-prefers-precomputed-location ()
  (should (equal (pi-feedback--format-note-location
                  (pi-feedback-test--note :location "app/models/foo.rb:old 10-11"
                                          :file "app/models/foo.rb"
                                          :startLine 20
                                          :endLine 21))
                 "app/models/foo.rb:old 10-11")))

(ert-deftest pi-feedback-list-renders-diff-metadata ()
  (pi-feedback-test--with-isolated-state
    (pi-feedback-test--with-temp-directory root
      (let ((default-directory root))
        (cl-letf (((symbol-function 'project-current) (lambda (&rest _args) nil)))
          (pi-feedback--set-notes
           root
           (list (pi-feedback-test--note :file "app/models/foo.rb"
                                         :location "app/models/foo.rb:old 10-11"
                                         :source "diff"
                                         :hunkHeader "@@ -10,3 +20,3 @@ def foo")))
          (unwind-protect
              (progn
                (pi-feedback-list)
                (with-current-buffer "*pi-feedback*"
                  (let ((content (buffer-string)))
                    (should (string-match-p
                             (regexp-quote "app/models/foo.rb:old 10-11") content))
                    (should (string-match-p (regexp-quote "Source: diff") content))
                    (should (string-match-p
                             (regexp-quote "Hunk: @@ -10,3 +20,3 @@ def foo") content)))))
            (when (get-buffer "*pi-feedback*")
              (kill-buffer "*pi-feedback*"))))))))

(ert-deftest pi-feedback-note-management-list-opens-read-only-dedicated-mode-buffer ()
  (pi-feedback-test--with-isolated-state
    (pi-feedback-test--with-temp-directory root
      (let ((default-directory root))
        (cl-letf (((symbol-function 'project-current) (lambda (&rest _args) nil)))
          (pi-feedback--set-notes root (list (pi-feedback-test--note :feedback "List this note")))
          (unwind-protect
              (progn
                (pi-feedback-list)
                (with-current-buffer "*pi-feedback*"
                  (should (eq major-mode 'pi-feedback-list-mode))
                  (should (derived-mode-p 'special-mode))
                  (should buffer-read-only)
                  (should (string-match-p "List this note" (buffer-string)))))
            (when (get-buffer "*pi-feedback*")
              (kill-buffer "*pi-feedback*"))))))))

(ert-deftest pi-feedback-note-management-isolates-next-id-state ()
  (pi-feedback-test--with-temp-directory root
    (let ((pi-feedback--next-ids (make-hash-table :test #'equal)))
      (puthash (pi-feedback--normalize-directory root) 99 pi-feedback--next-ids)
      (pi-feedback-test--with-isolated-state
        (should (zerop (hash-table-count pi-feedback--next-ids)))
        (puthash (pi-feedback--normalize-directory root) 2 pi-feedback--next-ids))
      (should (= (gethash (pi-feedback--normalize-directory root)
                          pi-feedback--next-ids)
                 99)))))

(ert-deftest pi-feedback-note-management-source-and-diff-capture-allocate-monotonic-ids ()
  (pi-feedback-test--with-isolated-state
    (pi-feedback-test--with-temp-directory root
      (let ((file (expand-file-name "src/example.rb" root)))
        (pi-feedback-test--with-file-buffer file "alpha\nbeta\n"
          (pi-feedback-test--activate-region (point-min) (line-end-position))
          (should (= (alist-get 'id
                                (pi-feedback--capture-region root "Source note."))
                     1))))
      (pi-feedback-test--with-diff-buffer pi-feedback-test--sample-diff
        (pi-feedback-test--select-text "+new one\n")
        (should (= (alist-get 'id
                              (pi-feedback--capture-diff-region root "Diff note."))
                   2)))
      (should (= (gethash (pi-feedback--normalize-directory root)
                          pi-feedback--next-ids)
                 3)))))

(ert-deftest pi-feedback-note-management-invalid-captures-do-not-allocate-ids ()
  (pi-feedback-test--with-isolated-state
    (pi-feedback-test--with-temp-directory root
      (let ((file (expand-file-name "src/example.rb" root)))
        (pi-feedback-test--with-file-buffer file "alpha\n"
          (pi-feedback-test--activate-region (point-min) (point-max))
          (should-error (pi-feedback--capture-region root "   ") :type 'user-error)))
      (pi-feedback-test--with-diff-buffer pi-feedback-test--sample-diff
        (pi-feedback-test--select-from-text-through-text "+new two\n" "+new later\n")
        (pi-feedback-test--should-diff-user-error
          (pi-feedback--capture-diff-region root "Invalid diff note.")))
      (should-not (gethash (pi-feedback--normalize-directory root)
                           pi-feedback--next-ids)))))

(ert-deftest pi-feedback-note-management-allocation-respects-stored-and-queued-ids ()
  (pi-feedback-test--with-isolated-state
    (pi-feedback-test--with-temp-directory root
      (pi-feedback--set-notes
       root
       (list (pi-feedback-test--note :id -1)
             (pi-feedback-test--note :id 7)
             (pi-feedback-test--note :id 9.5)))
      (puthash (pi-feedback--normalize-directory root) 12 pi-feedback--next-ids)
      (should (= (pi-feedback--allocate-note-id root) 12))
      (should (= (gethash (pi-feedback--normalize-directory root)
                          pi-feedback--next-ids)
                 13))
      (puthash (pi-feedback--normalize-directory root) 4 pi-feedback--next-ids)
      (should (= (pi-feedback--allocate-note-id root) 8)))))

(ert-deftest pi-feedback-note-management-set-notes-copies-and-never-lowers-next-id ()
  (pi-feedback-test--with-isolated-state
    (pi-feedback-test--with-temp-directory root
      (let ((notes (list (pi-feedback-test--note :id 7 :feedback "Original"))))
        (pi-feedback--set-notes root notes)
        (setf (alist-get 'feedback (car notes)) "Mutated")
        (should (equal (alist-get 'feedback (car (pi-feedback--notes root))) "Original"))
        (should (= (gethash (pi-feedback--normalize-directory root)
                            pi-feedback--next-ids)
                   8))
        (pi-feedback--set-notes root (list (pi-feedback-test--note :id 2)))
        (should (= (gethash (pi-feedback--normalize-directory root)
                            pi-feedback--next-ids)
                   8))
        (pi-feedback--set-notes root nil)
        (should-not (pi-feedback--notes root))
        (should (= (gethash (pi-feedback--normalize-directory root)
                            pi-feedback--next-ids)
                   8))))))

(ert-deftest pi-feedback-note-management-removal-never-reuses-ids ()
  (pi-feedback-test--with-isolated-state
    (pi-feedback-test--with-temp-directory root-middle
      (pi-feedback-test--with-temp-directory root-highest
        (pi-feedback-test--with-temp-directory root-final
          (pi-feedback--set-notes root-middle
                                  (list (pi-feedback-test--note :id 1)
                                        (pi-feedback-test--note :id 2)
                                        (pi-feedback-test--note :id 3)))
          (pi-feedback--set-notes root-middle
                                  (list (pi-feedback-test--note :id 1)
                                        (pi-feedback-test--note :id 3)))
          (should (= (pi-feedback--allocate-note-id root-middle) 4))
          (pi-feedback--set-notes root-highest
                                  (list (pi-feedback-test--note :id 1)
                                        (pi-feedback-test--note :id 2)
                                        (pi-feedback-test--note :id 3)))
          (pi-feedback--set-notes root-highest
                                  (list (pi-feedback-test--note :id 1)
                                        (pi-feedback-test--note :id 2)))
          (should (= (pi-feedback--allocate-note-id root-highest) 4))
          (pi-feedback--set-notes root-final (list (pi-feedback-test--note :id 1)))
          (pi-feedback--set-notes root-final nil)
          (should (= (pi-feedback--allocate-note-id root-final) 2)))))))

(ert-deftest pi-feedback-note-management-clear-resets-id-and-projects-are-isolated ()
  (pi-feedback-test--with-isolated-state
    (pi-feedback-test--with-temp-directory root-a
      (pi-feedback-test--with-temp-directory root-b
        (should (= (pi-feedback--allocate-note-id root-a) 1))
        (should (= (pi-feedback--allocate-note-id root-a) 2))
        (should (= (pi-feedback--allocate-note-id root-b) 1))
        (pi-feedback--clear-notes root-a)
        (should (= (pi-feedback--allocate-note-id root-a) 1))
        (should (= (pi-feedback--allocate-note-id root-b) 2))))))

(ert-deftest pi-feedback-note-management-failed-send-preserves-next-id ()
  (pi-feedback-test--with-isolated-state
    (pi-feedback-test--with-temp-directory root
      (let* ((missing (expand-file-name "missing.jsonl" root))
             (descriptor (pi-feedback-test--descriptor :sessionId "session-send-missing"
                                                       :projectRoot root
                                                       :cwd root
                                                       :inboxPath missing))
             (default-directory root))
        (pi-feedback--set-notes root (list (pi-feedback-test--note :id 5)))
        (cl-letf (((symbol-function 'project-current) (lambda (&rest _args) nil))
                  ((symbol-function 'pi-feedback--choose-session)
                   (lambda (_project-root) descriptor)))
          (should-error (pi-feedback-send) :type 'user-error))
        (should (= (gethash (pi-feedback--normalize-directory root)
                            pi-feedback--next-ids)
                   6))))))

(ert-deftest pi-feedback-note-management-list-mode-has-bindings-root-and-help ()
  (pi-feedback-test--with-isolated-state
    (pi-feedback-test--with-temp-directory root
      (pi-feedback-test--with-list-buffer root (list (pi-feedback-test--note))
        (should (eq major-mode 'pi-feedback-list-mode))
        (should buffer-read-only)
        (should (eq (lookup-key pi-feedback-list-mode-map (kbd "e"))
                    #'pi-feedback-edit-at-point))
        (should (eq (lookup-key pi-feedback-list-mode-map (kbd "d"))
                    #'pi-feedback-remove-at-point))
        (should (eq (lookup-key pi-feedback-list-mode-map (kbd "g"))
                    #'pi-feedback-list-refresh))
        (should (eq (lookup-key pi-feedback-list-mode-map (kbd "q"))
                    #'quit-window))
        (should (local-variable-p 'pi-feedback--list-project-root))
        (should (equal pi-feedback--list-project-root
                       (pi-feedback--normalize-directory root)))
        (should (string-match-p "e: edit" (buffer-string)))
        (should (string-match-p "d: remove" (buffer-string)))))))

(ert-deftest pi-feedback-note-management-list-properties-cover-notes-not-separators ()
  (pi-feedback-test--with-isolated-state
    (pi-feedback-test--with-temp-directory root
      (pi-feedback-test--with-list-buffer
          root
          (list (pi-feedback-test--note :id 1 :feedback "First feedback")
                (pi-feedback-test--note :id 2 :feedback "Second feedback"))
        (dolist (content '("Feedback 1 (src/example.rb:2)"
                           "Created: 2026-06-13T00:00:00.000Z"
                           "Quoted selection:"
                           "beta"
                           "First feedback"))
          (goto-char (point-min))
          (search-forward content)
          (should (= (get-text-property (1- (point)) 'pi-feedback-note-id) 1)))
        (goto-char (point-min))
        (search-forward "First feedback")
        (forward-line 1)
        (should-not (get-text-property (point) 'pi-feedback-note-id))
        (search-forward "Second feedback")
        (should (= (get-text-property (1- (point)) 'pi-feedback-note-id) 2))
        (forward-line 1)
        (should-not (get-text-property (point) 'pi-feedback-note-id))))))

(ert-deftest pi-feedback-note-management-edit-changes-only-selected-feedback ()
  (pi-feedback-test--with-isolated-state
    (pi-feedback-test--with-temp-directory root
      (let* ((notes (list (pi-feedback-test--note :id 1 :feedback "First")
                          (pi-feedback-test--note :id 2
                                                  :feedback "Second"
                                                  :source "diff"
                                                  :location "src/example.rb:old 2")))
             (before (copy-tree notes))
             initial-input
             notification)
        (pi-feedback-test--with-list-buffer root notes
          (pi-feedback-test--goto-note 2)
          (cl-letf (((symbol-function 'read-string)
                     (lambda (_prompt &optional initial &rest _args)
                       (setq initial-input initial)
                       "  Revised second  "))
                    ((symbol-function 'message)
                     (lambda (format-string &rest args)
                       (setq notification (apply #'format format-string args)))))
            (pi-feedback-edit-at-point))
          (let ((after (pi-feedback--notes root))
                (expected (copy-tree before)))
            (setf (alist-get 'feedback (cadr expected)) "Revised second")
            (should (equal after expected)))
          (should (equal initial-input "Second"))
          (should (= (gethash (pi-feedback--normalize-directory root)
                              pi-feedback--next-ids)
                     3))
          (should (string-match-p "Revised second" (buffer-string)))
          (should (string-match-p "Updated.*2" notification)))))))

(ert-deftest pi-feedback-note-management-edit-no-op-inputs-preserve-state ()
  (pi-feedback-test--with-isolated-state
    (pi-feedback-test--with-temp-directory root
      (let ((notes (list (pi-feedback-test--note :id 1 :feedback "Original"))))
        (pi-feedback-test--with-list-buffer root notes
          (let ((before (pi-feedback--notes root)))
            (dolist (input '("   " "  Original  "))
              (pi-feedback-test--goto-note 1)
              (cl-letf (((symbol-function 'read-string)
                         (lambda (&rest _args) input)))
                (pi-feedback-edit-at-point))
              (should (equal (pi-feedback--notes root) before)))
            (should (= (gethash (pi-feedback--normalize-directory root)
                                pi-feedback--next-ids)
                       2))))))))

(ert-deftest pi-feedback-note-management-cancelled-edit-preserves-state ()
  (pi-feedback-test--with-isolated-state
    (pi-feedback-test--with-temp-directory root
      (pi-feedback-test--with-list-buffer root (list (pi-feedback-test--note))
        (let ((before (pi-feedback--notes root)))
          (pi-feedback-test--goto-note 1)
          (let ((quit-signaled nil))
            (cl-letf (((symbol-function 'read-string)
                       (lambda (&rest _args) (signal 'quit nil))))
              (condition-case nil
                  (pi-feedback-edit-at-point)
                (quit (setq quit-signaled t))))
            (should quit-signaled))
          (should (equal (pi-feedback--notes root) before)))))))

(ert-deftest pi-feedback-note-management-stale-edit-revalidates-full-snapshot ()
  (pi-feedback-test--with-isolated-state
    (pi-feedback-test--with-temp-directory root
      (pi-feedback-test--with-list-buffer root (list (pi-feedback-test--note :feedback "Old"))
        (pi-feedback-test--goto-note 1)
        (cl-letf (((symbol-function 'read-string)
                   (lambda (&rest _args)
                     (let ((newer (pi-feedback--notes root)))
                       (setf (alist-get 'quote (car newer)) "newer quote\n")
                       (pi-feedback--set-notes root newer))
                     "Attempted edit")))
          (let ((error-data (should-error (pi-feedback-edit-at-point) :type 'user-error)))
            (should (string-match-p "changed" (error-message-string error-data)))))
        (let ((current (car (pi-feedback--notes root))))
          (should (equal (alist-get 'feedback current) "Old"))
          (should (equal (alist-get 'quote current) "newer quote\n")))))))

(ert-deftest pi-feedback-note-management-declined-and-cancelled-removal-preserve-state ()
  (pi-feedback-test--with-isolated-state
    (pi-feedback-test--with-temp-directory root
      (pi-feedback-test--with-list-buffer root (list (pi-feedback-test--note))
        (let ((before (pi-feedback--notes root)))
          (pi-feedback-test--goto-note 1)
          (cl-letf (((symbol-function 'y-or-n-p) (lambda (&rest _args) nil)))
            (pi-feedback-remove-at-point))
          (should (equal (pi-feedback--notes root) before))
          (pi-feedback-test--goto-note 1)
          (let ((quit-signaled nil))
            (cl-letf (((symbol-function 'y-or-n-p)
                       (lambda (&rest _args) (signal 'quit nil))))
              (condition-case nil
                  (pi-feedback-remove-at-point)
                (quit (setq quit-signaled t))))
            (should quit-signaled))
          (should (equal (pi-feedback--notes root) before)))))))

(ert-deftest pi-feedback-note-management-removes-middle-highest-and-final-note ()
  (pi-feedback-test--with-isolated-state
    (pi-feedback-test--with-temp-directory root
      (let ((prompts nil)
            (notifications nil))
        (pi-feedback-test--with-list-buffer
            root
            (list (pi-feedback-test--note :id 1 :feedback "First")
                  (pi-feedback-test--note :id 2 :feedback "Middle")
                  (pi-feedback-test--note :id 3 :feedback "Highest"))
          (cl-letf (((symbol-function 'y-or-n-p)
                     (lambda (prompt)
                       (push prompt prompts)
                       t))
                    ((symbol-function 'message)
                     (lambda (format-string &rest args)
                       (push (apply #'format format-string args) notifications))))
            (pi-feedback-test--goto-note 2)
            (pi-feedback-remove-at-point)
            (should (equal (mapcar (lambda (note) (alist-get 'id note))
                                   (pi-feedback--notes root))
                           '(1 3)))
            (pi-feedback-test--goto-note 3)
            (pi-feedback-remove-at-point)
            (should (equal (mapcar (lambda (note) (alist-get 'id note))
                                   (pi-feedback--notes root))
                           '(1)))
            (pi-feedback-test--goto-note 1)
            (pi-feedback-remove-at-point))
          (should-not (pi-feedback--notes root))
          (should (= (gethash (pi-feedback--normalize-directory root)
                              pi-feedback--next-ids)
                     4))
          (should (string-match-p "No queued Emacs feedback" (buffer-string)))
          (should (= (length notifications) 3))
          (should (seq-some (lambda (prompt)
                              (and (string-match-p "2" prompt)
                                   (string-match-p
                                    (regexp-quote "src/example.rb:2") prompt)))
                            prompts)))))))

(ert-deftest pi-feedback-note-management-stale-removal-revalidates-full-snapshot ()
  (pi-feedback-test--with-isolated-state
    (pi-feedback-test--with-temp-directory root
      (pi-feedback-test--with-list-buffer root (list (pi-feedback-test--note :feedback "Old"))
        (pi-feedback-test--goto-note 1)
        (cl-letf (((symbol-function 'y-or-n-p)
                   (lambda (&rest _args)
                     (let ((newer (pi-feedback--notes root)))
                       (setf (alist-get 'createdAt (car newer))
                             "2026-06-14T00:00:00.000Z")
                       (pi-feedback--set-notes root newer))
                     t)))
          (let ((error-data (should-error (pi-feedback-remove-at-point) :type 'user-error)))
            (should (string-match-p "changed" (error-message-string error-data)))))
        (let ((remaining (pi-feedback--notes root)))
          (should (= (length remaining) 1))
          (should (equal (alist-get 'feedback (car remaining)) "Old"))
          (should (equal (alist-get 'createdAt (car remaining))
                         "2026-06-14T00:00:00.000Z")))))))

(ert-deftest pi-feedback-note-management-actions-outside-notes-raise-user-error ()
  (pi-feedback-test--with-isolated-state
    (pi-feedback-test--with-temp-directory root
      (pi-feedback-test--with-list-buffer root (list (pi-feedback-test--note))
        (dolist (command '(pi-feedback-edit-at-point pi-feedback-remove-at-point))
          (goto-char (point-min))
          (let ((error-data (should-error (funcall command) :type 'user-error)))
            (should (string-match-p "inside a queued feedback note"
                                    (error-message-string error-data))))
          (pi-feedback-test--goto-note 1)
          (search-forward "Please revisit this.")
          (forward-line 1)
          (should-not (get-text-property (point) 'pi-feedback-note-id))
          (let ((error-data (should-error (funcall command) :type 'user-error)))
            (should (string-match-p "inside a queued feedback note"
                                    (error-message-string error-data)))))))))

(ert-deftest pi-feedback-note-management-refresh-uses-authoritative-queue ()
  (pi-feedback-test--with-isolated-state
    (pi-feedback-test--with-temp-directory root
      (pi-feedback-test--with-list-buffer root (list (pi-feedback-test--note :feedback "Queued truth"))
        (let ((inhibit-read-only t))
          (goto-char (point-min))
          (search-forward "Queued truth")
          (replace-match "Rendered forgery" t t))
        (pi-feedback-list-refresh)
        (should (string-match-p "Queued truth" (buffer-string)))
        (should-not (string-match-p "Rendered forgery" (buffer-string)))
        (should (equal (alist-get 'feedback (car (pi-feedback--notes root)))
                       "Queued truth"))))))

(ert-deftest pi-feedback-note-management-edit-never-parses-rendered-text ()
  (pi-feedback-test--with-isolated-state
    (pi-feedback-test--with-temp-directory root
      (pi-feedback-test--with-list-buffer root (list (pi-feedback-test--note :feedback "Queued truth"))
        (let ((inhibit-read-only t))
          (goto-char (point-min))
          (search-forward "Queued truth")
          (replace-match "Rendered forgery" t t))
        (pi-feedback-test--goto-note 1)
        (cl-letf (((symbol-function 'read-string)
                   (lambda (_prompt &optional initial &rest _args)
                     (should (equal initial "Queued truth"))
                     "Updated truth")))
          (pi-feedback-edit-at-point))
        (should (equal (alist-get 'feedback (car (pi-feedback--notes root)))
                       "Updated truth"))))))

(ert-deftest pi-feedback-clear-asks-for-confirmation-before-clearing ()
  (pi-feedback-test--with-isolated-state
    (pi-feedback-test--with-temp-directory root
      (let ((default-directory root)
            (confirmations 0))
        (pi-feedback--set-notes root (list (pi-feedback-test--note :feedback "Keep me")))
        (cl-letf (((symbol-function 'project-current) (lambda (&rest _args) nil))
                  ((symbol-function 'y-or-n-p)
                   (lambda (_prompt)
                     (setq confirmations (1+ confirmations))
                     nil)))
          (pi-feedback-clear)
          (should (= confirmations 1))
          (should (= (length (pi-feedback--notes root)) 1)))))))

(ert-deftest pi-feedback-note-management-confirmed-clear-resets-next-id ()
  (pi-feedback-test--with-isolated-state
    (pi-feedback-test--with-temp-directory root
      (let ((default-directory root))
        (pi-feedback--set-notes root (list (pi-feedback-test--note :id 7)))
        (cl-letf (((symbol-function 'project-current) (lambda (&rest _args) nil))
                  ((symbol-function 'y-or-n-p) (lambda (&rest _args) t)))
          (pi-feedback-clear))
        (should-not (pi-feedback--notes root))
        (should-not (gethash (pi-feedback--normalize-directory root)
                             pi-feedback--next-ids))
        (should (= (pi-feedback--allocate-note-id root) 1))))))

;;; pi-feedback-test.el ends here
