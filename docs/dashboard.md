# Dashboard guide

## Projects and profile

Sign in to create a project for an app. A project contains its screens, reusable blocks, environments, app manifest, and team settings. Upload the app's supported components and actions from CI with `zyrox manifest push` so the editor can validate documents against the app build.

Use **Profile** from the project list or project sidebar to change the name shown to teammates. Email addresses are read-only. Project administrators can delete a project from the project list; this permanently removes the project's documents, releases, environments, and settings.

## Screens and blocks

Create a screen or block from **Screens & blocks**. Screens are app entry points. Blocks are reusable fragments referenced by screens as `@block/<key>` and can accept input from their parent.

The editor's **Layers** outline supports selecting, duplicating, and deleting nodes. The JSON mode offers schema validation and property suggestions. Editors can save drafts; publishers can publish validated versions.

Publishing a block creates a version but does not release it to an environment. A screen that references the block uses its latest published block version the next time that screen is published. Publish the screen to make the expanded content live.

Administrators can archive a screen or block from its row in **Screens & blocks**. Archiving removes it from the list and delivery; it does not provide an undo action. Project deletion is also permanent.

## Roles

Viewers can inspect project content. Editors can create and change drafts. Publishers can publish and release versions. Administrators can manage members and settings, and delete documents or projects.

See [Self-hosting](self-hosting.md) for server setup and [Headless](headless.md) for the admin API.