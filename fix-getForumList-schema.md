# תיקון: xenforo_pro.getForumList — properties: [] → {}

## הבעיה

הכלי `xenforo_pro.getForumList` מחזיר `input_schema` לא חוקי:

```json
"input_schema": {
    "type": "object",
    "properties": []
}
```

`properties` הוא **מערך ריק** (`[]`) במקום **אובייקט ריק** (`{}`).

לפי JSON Schema spec, `properties` חייב להיות אובייקט. מערך הוא לא חוקי.

### למה זה קורה ב-PHP

`json_encode([])` ב-PHP מחזיר `[]` (מערך JSON).
כדי לקבל `{}` (אובייקט JSON) צריך `(object)[]` או `new \stdClass()`.

### השפעה

Claude Desktop דוחה את **כל** רשימת הכלים בשקט כשיש כלי אחד עם schema לא חוקי.
9 כלים תקינים לא נטענים בגלל כלי אחד שבור.

---

## איך לתקן

### שלב 1 — מצא את הקובץ

חפש את ההגדרה של `getForumList` בקוד ה-PHP של התוסף.

הקובץ נמצא כנראה באחד מהמיקומים האלה:
- `src/addons/AIConnect/Service/ToolRegistry.php`
- `src/addons/AIConnect/Api/Manifest.php`
- `src/addons/AIConnect/XF/Api/Controller/AiConnect.php`

חפש את המחרוזת: `getForumList`

### שלב 2 — מצא את ה-input_schema

תחפש קוד שנראה כך:

```php
'name' => 'xenforo_pro.getForumList',
'input_schema' => [
    'type' => 'object',
    'properties' => [],   // ← זו הבעיה
],
```

### שלב 3 — תקן

החלף את `[]` ב-`(object)[]`:

```php
'name' => 'xenforo_pro.getForumList',
'input_schema' => [
    'type' => 'object',
    'properties' => (object)[],   // ← תקין
],
```

**או** — הסר את `properties` לגמרי (חוקי לפי spec לכלים ללא פרמטרים):

```php
'name' => 'xenforo_pro.getForumList',
'input_schema' => [
    'type' => 'object',
],
```

### שלב 4 — בדוק

אחרי התיקון, בדוק את ה-manifest endpoint:

```
GET https://<your-site>/xf/api/aiconnect-manifest
Authorization: Bearer <token>
```

חפש את `xenforo_pro.getForumList` בתוצאה ווודא:

```json
"properties": {}
```

ולא:

```json
"properties": []
```

---

## בדיקה נוספת — Audit לכלים דומים

חפש בכל קוד התוסף את הדפוס הבעייתי:

```
'properties' => []
```

כלים ללא פרמטרים (כמו `getCurrentUser`, `getForumList`) הם המועמדים הסבירים.
תקן כל מקרה כזה עם `(object)[]`.

---

## הערה

התיקון ב-webmcp-client (v2.0.4+) כבר מגן על הקליינט מפני הבעיה הזו —
כלי עם `properties: []` יקבל schema מתוקן אוטומטית ולא יפיל את שאר הכלים.
אבל התיקון בתוסף עצמו הוא הנכון לטווח ארוך.
