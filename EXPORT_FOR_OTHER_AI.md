# סיכום מקיף של פרויקט "אוצר ספרים" - מוכן להעברה לכל AI (Claude / ChatGPT / Gemini / Cursor)

מסמך זה מרכז את כל פרטי השיחה, ההנחיות, הדרישות, הארכיטקטורה, מבנה הנתונים, הקבצים שנבנו והמצב העדכני של המערכת.
ניתן להעתיק את תוכן מסמך זה ולהדביק אותו בתור הודעה ראשונה לכל סוכן או מודל AI אחר כדי שימשיך לעבוד בצורה רציפה.

---

## 1. פרומפט המשך מוכן להעתקה ל-AI החדש (Copy-Paste Prompt)

```markdown
שלום, אתה מהנדס התוכנה הראשי שממשיך פיתוח של פרויקט קיים בשם "אוצר ספרים" (מערכת ניהול ספריית ישיבה תורנית דסקטופית אופליין-פירסט).
הפרויקט כבר קיים במלואו, נבנה ב-5 שלבים ופועל על המחשב המקומי (Windows) בנתיב: C:\OtzarSefarim
הפרויקט רץ מקומית דרך Node.js ו-Express על פורט 127.0.0.1:4747 ונפתח בחלון עצמאי של Microsoft Edge (--app).

להלן כל הפרטים הטכניים, הארכיטקטורה, מסד הנתונים, מה שכבר הושלם, וההחלטות שהתקבלו עם המשתמש:
```

---

## 2. מטרת המערכת ודרישות היסוד
- **שם המערכת**: "אוצר ספרים" — ניהול ספריית ישיבה.
- **אופי המערכת**: יישום שולחני (Desktop Web App), אופליין-פירסט (Offline-First), בשפה העברית עם ממשק RTL מלא.
- **עיצוב ומיתוג**: השראה מעיצוב "אוצר החוכמה" — שילוב צבעים לבן/קרם וכתום עמוק (`#FFFFFF` / `#FFF7ED` / `#EA580C`), תמיכה בערכות צבעים (כתום-לבן, כחול קלאסי, ירוק זית) ומצב כהה (Dark Mode).
- **סביבת הרצה מקומית**:
  - תיקיית הפרויקט: `C:\OtzarSefarim`
  - קובץ הפעלה מהיר בדסקטופ: `C:\OtzarSefarim\launch.bat` שמפעיל את השרת ופותח `msedge --app=http://127.0.0.1:4747` במסך מלא.
  - מסד נתונים מקומי: SQLite (`C:\OtzarSefarim\data\otzar.db`) באמצעות הדרייבר המובנה `node:sqlite` (Node v26).

---

## 3. היסטוריית בקשות המשתמש והחלטות מפתח שהתקבלו
1. **שגיאה בשמירת המפה**: תוקנה בעיית שמירה במודול עורך המפה הדו-ממדית.
2. **"קיר דמיוני" בהזזת ארונות ימינה**: תוקן חישוב הגבולות וה-clamping במפה כך שרוטציה (90°/180°/270°) מתחשבת ברוחב/גובה הממשי ולא חוסמת תנועה.
3. **מיקום הכניסה לספרייה**:
   - המשתמש ביקש למקם את הכניסה ישירות על גבי המפה.
   - המשתמש ציין כי הבר הצדדי "מיקום הכניסה לספרייה" מיותר — הבר הוסר, וסמן הכניסה ניתן לגרירה ישירה על גבי לוח המפה (Canvas).
4. **שינוי מידות ארונות בקלות**:
   - הוספו 8 ידיות שינוי גודל (4 פינות ו-4 צלעות) המאפשרות משיכה ישירה של אורך ורוחב הארון באמצעות העכבר.
5. **הפרדה מלאה בין משתמש רגיל (עמדת קיוסק) לבין מנהל (Admin)**:
   - **עמדת משתמש רגיל (ברירת מחדל)**: רואה **רק** "חיפוש ואיתור" (כולל מפה דו-ממדית) ו"השאלה והחזרה".
   - כפתורי הוספה/עריכה/מחיקה של ספרים, ייבוא שואלים, קטלוג ו-AI, הדפסת מדבקות, עורך מפה, הגדרות ופרטי DB — כולם מוסתרים בממשק וחסומים בשרת (מחזירים שגיאת `401 Unauthorized`).
   - **כניסת מנהל**: באמצעות כפתור עדין בתחתית הסרגל או בקיצור המקלדת `Ctrl+Shift+A`.
   - **קוד PIN ראשוני**: `1234` (ניתן לשינוי בהגדרות).
   - **נעילה**: כפתור מהיר "נעל לעמדת משתמש" בראש המסך.
6. **עריכת ספרים קיימים**:
   - נוסף כפתור עיפרון (עריכה) ישירות בשורת התוצאות בחיפוש וכן בתוך חלון המיקום (Location Modal) עבור מנהל.
7. **כיוון עברית במדבקות (הבקשה האחרונה)**:
   - ה-PDF המוטמע הציג עברית במהופך כיוון שנעשה שימוש כפול ב-bidi-js יחד עם fontkit. תוקן כך שמועבר טקסט ישיר ו-fontkit מעצב ומסדר את הגליפים בצורה תקינה.

---

## 4. ארכיטקטורה טכנולוגית (Tech Stack)
- **Frontend**:
  - React 18, TypeScript, Vite, Tailwind CSS.
  - אייקונים: `lucide-react`.
  - קומפוננטות ראשיות:
    - `App.tsx` — מעטפת ראשית, ניהול מצב Admin/משתמש רגיל, מעקב PIN, טעינת ערכות נושא.
    - `SearchModule.tsx` — חיפוש תורני מקומי מתקדם, סינון קטגוריות/סטטוס, כפתור איתור במפה, עריכת ספר מהירה.
    - `LibraryMap2D.tsx` — תצוגת מפת ספרייה דו-ממדית לקורא (ארונות, מדפים, הדגשת הארון המבוקש והכניסה).
    - `MapEditorModule.tsx` — עורך מפה למנהל (גרירה, שינוי אורך/רוחב ב-8 ידיות, סיבוב ב-90 מעלות, הוספת/מחיקת ארונות).
    - `CirculationModule.tsx` — מערכת השאלה והחזרה (סל השאלות מרובה ברקודים, זיהוי ספרי עיון, החזרה מהירה, איחורים, ניהול שואלים וייבוא).
    - `CatalogModule.tsx` — קטלוג ספרים מהיר, צילום מצלמת רשת / העלאת קבצים, דחיסה מקומית ב-Canvas, פענוח OCR עם Gemini, פיצול עותקים ויצירת ברקודים רציפים.
    - `LabelsModule.tsx` — תור הדפסת מדבקות A4, בחירת מיקום התחלה ("מדבקה מספר X בדף"), הגדרות מילימטרים ושוליים, תצוגה מקדימה מוטמעת של ה-PDF.
    - `AdminPinModal.tsx` — חלונית הזנת PIN מהירה למנהל.
    - `AiSettingsPanel.tsx` — הגדרות מפתח Gemini, בדיקת חיבור, סטטיסטיקת וקטורים ואינדוקס סמנטי.
- **Backend**:
  - Node.js (v26.13.1) עם Express ו-TypeScript (`tsx`).
  - מסד נתונים: `node:sqlite` (המודול המובנה של Node.js 22+ ללא תלות ב-node-gyp/compilers).
  - עיבוד PDF: `pdf-lib` יחד עם `@pdf-lib/fontkit` והטמעת גופן Arial עברי מ-`C:\Windows\Fonts\arial.ttf`.
  - ברקודים: `bwip-js` להפקת ברקוד תקני Code 128.
  - עיבוד אקסל: ספריית `xlsx` לייבוא וייצוא קטלוג ושואלים.
  - בינה מלאכותית: `@google/genai` (SDK הרשמי החדש) עבור Gemini OCR וחיפוש סמנטי היברידי (`gemini-embedding-001`).

---

## 5. מבנה מסד הנתונים (Database Schema - 6 טבלאות)
נמצא ב-`C:\OtzarSefarim\server\db\schema.ts`:
1. `books`:
   - `id` (INTEGER PRIMARY KEY)
   - `barcode` (TEXT UNIQUE NOT NULL)
   - `title` (TEXT NOT NULL)
   - `author` (TEXT)
   - `category` (TEXT NOT NULL)
   - `volume` (TEXT)
   - `cabinet_code` (TEXT)
   - `shelf_number` (INTEGER)
   - `copies_total`, `copies_available` (INTEGER)
   - `is_reference_only` (INTEGER 0/1)
   - `status` (TEXT: in_library / loaned / lost / damaged)
   - `embedding` (BLOB - 768 float32 dimensions)
   - `created_at`, `updated_at` (TEXT)
2. `cabinets`:
   - `code` (TEXT PRIMARY KEY)
   - `subject` (TEXT)
   - `shelves_count` (INTEGER)
   - `x`, `y`, `width`, `height`, `rotation` (INTEGER)
3. `borrowers`:
   - `id` (INTEGER PRIMARY KEY)
   - `full_name` (TEXT NOT NULL)
   - `phone` (TEXT)
   - `email` (TEXT)
   - `group_name` (TEXT)
   - `notes` (TEXT)
   - `is_active` (INTEGER 0/1)
4. `loans`:
   - `id` (INTEGER PRIMARY KEY)
   - `book_id`, `borrower_id` (INTEGER)
   - `loan_date`, `due_date`, `return_date` (TEXT)
   - `status` (TEXT: active / returned / overdue)
5. `print_queue`:
   - `id` (INTEGER PRIMARY KEY)
   - `book_id` (INTEGER)
   - `added_at`, `printed_at` (TEXT)
   - `is_printed` (INTEGER 0/1)
6. `settings`:
   - `key` (TEXT PRIMARY KEY)
   - `value` (TEXT)
   - מפתחות שמורים: `library_name`, `default_loan_days`, `theme_preset`, `theme_mode`, `map_entrance`, `ai_api_key`, `ai_model`, `admin_pin`, `a4_template`, `label_config`.

---

## 6. פירוט מסלולי ה-API (Endpoints)
- **ציבורי (עמדת משתמש רגיל)**:
  - `GET /api/health` — בריאות שרת וספירות מסד נתונים.
  - `GET /api/settings` — מחזיר הגדרות ציבוריות (מסנן את `admin_pin` ו-`ai_api_key`, ומחזיר `has_api_key: true/false`).
  - `GET /api/books?q=...` — חיפוש תורני / סמנטי אופליין.
  - `GET /api/cabinets` — רשימת ארונות עבור המפה.
  - `GET /api/loans` — רשימת השאלות פעילות ובאיחור.
  - `GET /api/loans/lookup/:barcode` — בדיקת ברקוד לקראת השאלה/החזרה.
  - `POST /api/loans/checkout` — השאלת ספרים לסל שואל.
  - `POST /api/loans/return` — החזרת ספרים מהירה.
  - `PUT /api/loans/:id/extend` — הארכת תוקף השאלה.
  - `GET /api/borrowers` — רשימת שואלים להשאלה.
  - `POST /api/admin/login` — כניסת מנהל באמצעות PIN.
  - `POST /api/admin/logout` — יציאת מנהל.
- **מוגן למנהל בלבד (דורש כותרת x-admin-token)**:
  - `PUT /api/settings` — עדכון הגדרות מערכת ומפתחות.
  - `POST /api/admin/pin` — שינוי קוד PIN.
  - `POST /api/books`, `PUT /api/books/:id`, `DELETE /api/books/:id` — ניהול ספרים.
  - `POST /api/cabinets`, `PUT /api/cabinets`, `DELETE /api/cabinets/:code` — ניהול מפה.
  - `POST /api/borrowers`, `PUT /api/borrowers/:id`, `DELETE /api/borrowers/:id` — ניהול שואלים.
  - `POST /api/borrowers/import-preview`, `POST /api/borrowers/import-commit` — ייבוא שואלים מקובץ.
  - `GET /api/labels/queue`, `POST /api/labels/queue/add`, `POST /api/labels/queue/mark-printed` — תור מדבקות.
  - `POST /api/labels/generate-pdf` — הפקת PDF מדבקות A4.
  - `GET /api/export/books.xlsx`, `GET /api/export/books.csv` — ייצוא קטלוג.
  - `GET /api/backup/download`, `POST /api/backup/save-local` — גיבוי מסד נתונים.
  - כל מסלולי ה-AI: `/api/ai/*`, `/api/ai-queue/*`.

---

## 7. פקודות שימושיות להרצה ובדיקה ב-Windows PC
- **הפעלה מלאה של האפליקציה**:
  לחיצה כפולה על: `C:\OtzarSefarim\launch.bat`
- **בניית Frontend מחדש**:
  `cmd /c "cd /d C:\OtzarSefarim && npm run build"`
- **הפעלת שרת הפיתוח ישירות**:
  `cmd /c "cd /d C:\OtzarSefarim && npx tsx server/index.ts"`
- **בדיקת בריאות שרת**:
  `curl http://127.0.0.1:4747/api/health`
