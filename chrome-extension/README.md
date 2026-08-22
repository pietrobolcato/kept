# Kept Chrome extension

1. Deploy Kept or run it locally.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked** and choose this `chrome-extension` folder.
5. Open the extension’s **Details → Extension options**.
6. Enter your Kept URL (`http://localhost:8787` for a local production server, or the deployed HTTPS URL) and sign in.
7. Use the shortcuts shown on the options page. Suggested defaults are **⌘⇧K** to keep the current page and **⌘⇧E** to visually choose an element.

Arc and Chrome may reserve a suggested shortcut without assigning it. In Arc, open `arc://extensions/shortcuts`; in Chrome, open `chrome://extensions/shortcuts`. Find **Kept — visual memory** and assign any available combination.

You can always click the Kept toolbar icon to save the current page, or right-click the page to use **Keep this page** / **Choose something to keep…**.

The extension is not tied to a hosted Kept instance. Its options page stores your chosen base URL in extension-local storage. Choosing **Change instance** clears the prior session before connecting to another deployment.
