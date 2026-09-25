# Fix for `null value in column "email" of relation "users"`

The Node/PostgreSQL auth flow now supports an `email` column. Registration accepts an email from the form; the backend also generates `<username>@rebank.local` when a client does not send an email, so existing clients do not break.

For an existing database run:

```powershell
cd C:\Users\Asus\Desktop\re-bank\backend-node
npm run db:init
```

Then start the API with:

```powershell
npm start
```
