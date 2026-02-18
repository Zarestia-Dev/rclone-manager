# Creating and Managing Remotes

Welcome to the command center. This page covers the entire lifecycle of your remotes from their glorious creation to their inevitable deletion.

If you are in a panic and just need to find out how to delete a remote, or if you simply lack the attention span for my meticulously crafted guide, use the directory below.

## 🗂️ The "I'm in a Hurry" Directory

* **[I want to Add a simple remote (Drive, Dropbox) ➔](https://github.com/Zarestia-Dev/rclone-manager/wiki/Remote-Management/#2-the-quick-remote-modal)**
* **[I want to Add an advanced remote (S3, Mega, etc.) ➔](https://github.com/Zarestia-Dev/rclone-manager/wiki/Remote-Management/#3-the-detailed-remote-add-modal)**
* **[I need to use Interactive Setup (OneDrive, etc.) ➔](https://github.com/Zarestia-Dev/rclone-manager/wiki/Remote-Management/#5-using-the-interactive-configuration)**
* **[I want to Edit my remote's config ➔](https://github.com/Zarestia-Dev/rclone-manager/wiki/Remote-Management/#4-editing-a-remote)**
* **[I want to Delete a remote ➔](https://github.com/Zarestia-Dev/rclone-manager/wiki/Remote-Management/#6-other-remote-actions)**
* **[I want to Encrypt my passwords ➔](https://github.com/Zarestia-Dev/rclone-manager/wiki/Remote-Management/#7-securing-your-configuration-encryption)**

---

## 1. Initiating the Process

<p align="center">
<img height="500" alt="New Remote UI" src="https://github.com/user-attachments/assets/8bb35a82-1a14-4e12-bc65-ce4ca6e4f41c" />
</p>

Adding a new remote is the mandatory first step toward digital enlightenment or at least managing your cloud storage with **Rclone Manager**.

To begin, navigate to the **Remotes** section from the main dashboard.

* Look for the **"+" (Add)** button in the top left corner.
* If you haven't added any remotes yet (how lonely), you will see two prominent buttons in the center of the UI.
* You have two paths to choose from: **"Add Quick Remote"** or **"Add Detailed Remote."** Both will open the Remote Creation Wizard (or "The Modal," as I like to call it).

---

## 2. The Quick Remote Modal

<p align="center">
<img height="500" alt="Quick Remote Modal" src="https://github.com/user-attachments/assets/0b5c5cf5-a153-4733-8a2f-d1aa07f3bf95" />
</p>

As the name implies, the Quick Remote modal is for those who value their time. This option is designed for providers that support browser-based authentication, such as Google Drive, Dropbox, or OneDrive.

Simply search for your provider in the **"Remote type"** dropdown. The app will assign a default name to your remote, but feel free to rename it if "drive-1" doesn't satisfy your creative urges.

> **Note:** For more complex setups like OneDrive and iCloud Drive, you might need "Interactive Configuration." We shall discuss that in **Section 3.5**.

### 2.1 Finalizing the Remote

<p align="center">
<img height="500" alt="Final Config" src="https://github.com/user-attachments/assets/40a5a542-5261-4a41-b279-2c9fea791c27" />
</p>

Once your identification details are set, press the **"Create Remote +"** button. For providers like Google Drive, an OAuth sequence will begin.

<p align="center">
<img height="500" alt="OAuth Sequence" src="https://github.com/user-attachments/assets/71d27941-e868-44d4-80ad-aa9a1bbedfd5" />
</p>

Rclone Manager handles this in a separate process. If you hit "Cancel," your other running operations will remain completely undisturbed. Your default browser will open a login page; once you authorize it, the modal will close, and your new remote will manifest in the list.

<p align="center">
<img height="500" alt="Success UI" src="https://github.com/user-attachments/assets/09d2ec04-239c-4083-a63c-a6522440d409" />
</p>

**Congratulations!** You've added your first remote. It is now registered and ready for you to configure its specific jobs.

---

## 3. The Detailed Remote Add Modal

So, you’ve mastered the Quick Remote. How efficient of you. But perhaps you crave more control. The Detailed Remote modal contains every single remote type supported by `Rclone`. It also allows you to micromanage every secret detail of that connection.

Access the modal via the **"+"** icon in the top left, and select **"Detailed Remote"**.

<p align="center">
<img height="500" alt="Detailed UI" src="https://github.com/user-attachments/assets/1eea1a40-9787-4037-becb-70467a93ac1c" />
</p>

For this experiment, let's add a **Mega** remote:

<p align="center">
<img height="500" alt="Mega Selection" src="https://github.com/user-attachments/assets/8b73a048-fc4d-4a74-897f-5155b019b061" />
</p>

Unlike Google Drive, Mega does not believe in the luxury of "OAuth" or opening browsers for you. You must configure it manually.

By default, I have hidden the most terrifying advanced configuration fields to prevent unnecessary confusion. However, if you choose to enable them, I have organized them into a pleasing blue-background section that even counts the fields for you. Why did I add a counter? Let’s just call it "data appreciation."

<p align="center">
<img height="500" alt="Advanced Fields" src="https://github.com/user-attachments/assets/18a2ebad-e74a-4ff2-90d3-5dac7deb7b85" />
</p>

> [!IMPORTANT]
> **A Note on Security:** If "Restrict Values" is enabled in your settings (and it is, by default), you cannot copy, paste, or cut password inputs. You also cannot see them. This is for your own protection. I strongly recommend leaving this enabled, especially if you are operating in a headless environment.

**Navigation Tip:** Use the icon bar at the top to skip between the different configuration categories like Mount, Sync, and Advanced settings. Efficiency is key.

Since Mega is far too proud for browser-based OAuth, saving this remote does not open a web page. Instead, Rclone simply attempts a direct connection. If your manual inputs were correct, the remote is immediately added to your arsenal.

<p align="center">
<img height="500" alt="Remote Added Success" src="https://github.com/user-attachments/assets/35f8eb0b-d208-4e03-8902-01cd8a6b7b0b" />
</p>

---

## 3.5 Using the Interactive Configuration

Let us discuss "Interactive Configuration." This is not your standard "click a button, get a token, and go to sleep" setup. This mimics the native Rclone terminal experience, but elevated with Rclone Manager's aesthetic superiority. Let's use OneDrive as our test subject.

<p align="center">
<img height="500" alt="Interactive Setup OneDrive" src="https://github.com/user-attachments/assets/9915773c-7291-418d-9637-b1ecf44f74c2" />
</p>

It does not matter which modal you initiate this from; the underlying logic remains identical (I am not lazy; it is called consistent UI design). When you start this setup, it will not handle everything automatically. It will interrogate you with a series of questions.

<p align="center">
<img height="500" alt="Interactive Prompts 1" src="https://github.com/user-attachments/assets/e84b907c-5f0b-4e0a-8f4a-f69fac1c70b8" />
</p>

First, it will demand that you open a browser to connect, exactly like the Rclone CLI configuration.

<p align="center">
<img height="500" alt="Interactive Prompts 2" src="https://github.com/user-attachments/assets/0114ca95-8b5d-4efc-8363-bb68da83ba5b" />
</p>

Then, it will ask for configuration specifics, such as your Drive Type, Drive ID, and so forth. Finally, the interrogation ends. Unlike the CLI, this wizard will *not* pester you with "Do you want to edit advanced configurations?" at the very end. It purely handles the connection setup.

This interactive logic is necessary for providers like OneDrive, which require you to select specific Drive IDs *after* obtaining the initial web token (unlike Google Drive, which kindly finishes the process immediately).

---

## 4. Editing a Remote

You have successfully added a remote. Adequate progress. But what if you make a mistake, or simply change your mind? Rclone Manager graciously allows you to edit your remotes. Even remotes created outside of this application via the command line are supported. We do not discriminate against manually typed configs; we merely pity them.

First, you must locate your remote. If you only have a few, click the remote from the Quick Remote Access menu. If you have hoarded an excessive number of remotes, click the "hamburger" menu icon in the top left (just below the title bar) to open the sidebar. Next to the "Remotes" title, there is a hidden search toggle. Click it, type your query, and marvel at the efficiency of finding things quickly.

<p align="center">
<img height="500" alt="Search Remote" src="https://github.com/user-attachments/assets/f0770f25-44bd-45f2-9f42-3bd62254aaa5" />
</p>

Once found, click outside the sidebar to close it and view the remote's details. Here you can monitor your digital footprint: storage space used, active jobs (sync, mount, etc.), and the "Remote Configuration" accordion panel. It is currently collapsed to save screen space and protect you from feeling overwhelmed. Click to expand it.

<p align="center">
<img height="500" alt="Remote Details" src="https://github.com/user-attachments/assets/107e3ad1-3f02-4988-b2a1-42901b6bc571" />
</p>

Ah, there it is: the **"Edit Configuration"** button. Click it to enter the editing interface.

<p align="center">
<img height="500" alt="Edit Configuration" src="https://github.com/user-attachments/assets/3b44242a-1778-431d-b15a-36f03c36dce2" />
</p>

You might notice this looks exactly like the Detailed Remote Add modal. That is because it is the exact same modal, recycled for your convenience.

However, you will find that the **Remote Name** and **Remote Type** are locked. Those are permanent choices. If you suffer from regret regarding the name, please proceed to the "Clone Remote" feature discussed in Section 6. You can, however, alter all other configurations.

I will leave mine as is, because my initial configuration was flawless. Let us close this modal.

---

## 5. Quick Actions

Back on the remote details page, direct your attention to the icons at the top. They may look like passive status indicators, but they are actually interactive **Quick Actions**.

<p align="center">
<img alt="Quick Actions Indicators" src="https://github.com/user-attachments/assets/0721de47-56fb-4b53-b70b-f6224898cc74" />
</p>

By default, Rclone Manager provides "Mount, Sync, and Bisync" as your quick actions. You are allowed a maximum of three. This arbitrary limit exists to maintain UI harmony and prevent you from cluttering the interface.

<p align="center">
<img alt="Quick Actions Selection" src="https://github.com/user-attachments/assets/cc9f8067-a3f8-46aa-9642-02be39d37411" />
</p>

Crucially, selecting these actions here also updates your system tray menu, allowing you to trigger operations without even opening the main application window. Efficiency at its finest.

---

## 6. Other Remote Actions

There are further operations available, tucked away in the vertical three-dot menu in the top right corner.

<p align="center">
<img height="500" alt="Three Dot Menu" src="https://github.com/user-attachments/assets/edd155e0-eccd-48c5-bc10-926c27b6f7ea" />
</p>

Let us review your options:

* **Display on Tray:** By default, new remotes demand attention and appear in your system tray. If you prefer them to suffer in silence out of sight, disable this toggle.
* **Logs:** Not just any logs, logs filtered *exclusively* for this remote. Imagine having to sift through hundreds of lines of global application text just to find out why your specific remote failed to sync. Now, you don't have to. You're welcome.

<p align="center">
<img height="500" alt="Remote Logs" src="https://github.com/user-attachments/assets/1fb97c6a-89ff-4459-a31e-316b452905e6" />
</p>

* **Clone Remote:** Remember my earlier lecture about the permanence of Remote Names in Edit Mode? If the regret is truly unbearable, use this option. It duplicates your configuration, allowing you to bestow a new name upon it. You still cannot change the remote *type*, however. We are cloning data, not performing digital alchemy.

<p align="center">
<img height="500" alt="Clone Remote" src="https://github.com/user-attachments/assets/5c737cb9-5fbf-456e-ba83-940b37cf4bca" />
</p>

* **Export Configuration:** You can export the configuration for this *single remote*. This is extremely useful if you need to back up a specific setup or share it with a similarly competent user.
* **Reset Settings:** This does not destroy your core remote configuration; it merely wipes your customized Mount, Serve, and Sync preferences back to their factory defaults. A clean slate for your operational parameters.
* **Delete Remote:** The nuclear option. Use it if you must. I will not mourn the deleted data, but you might.

---

## 7. Securing Your Configuration (Encryption)

So, we have our access tokens. We can access our data, including those beautiful school notes you swore you'd read but never did. However, there is a vulnerability. By default, Rclone stores your configuration file as **plain text**. Terrifying, isn't it? Anyone with access to your computer could simply open the file and read your secrets.

But fear not. Rclone Manager allows us to encrypt the configuration file, rendering it useless to prying eyes.

### 7.1 Accessing the Backend Manager

First, return to the main **Home** page. Look for the icon in the top left, right next to the "Add Remote" button. It resembles the Rclone logo, but with a filled circle. Click it.

<p align="center">
<img height="500" alt="Home Button" src="https://github.com/user-attachments/assets/7f5ddb3c-8692-44f1-a7e2-7d112c35ff21" />
</p>

You will see a green dot on the app logo and the text **"Local"**. Click this text. Ta-da!

<p align="center">
<img height="500" alt="Backend Selector" src="https://github.com/user-attachments/assets/1df20bea-59d6-41cd-9612-a639feff6e84" />
</p>

*Side Note:* You can technically access other Rclone instances on your NAS, your Mother’s PC, or some other remote device via this menu. However, for now, we must focus on securing your **Local** environment.

### 7.2 Editing the Local Backend

Locate the **Pencil Icon** next to the "Local" entry. This allows us to edit the backend configuration.

> **Note:** Rclone does not support editing or encrypting *remote* backend configurations through this specific interface. Stick to the local one for now.

**Useful Tip:** If you are curious about where this configuration file actually lives on your hard drive, hover your mouse over the green file icon at the start of the input field. The path will reveal itself.

<p align="center">
<img height="500" alt="Config Path Hover" src="https://github.com/user-attachments/assets/c2616fcf-c412-4341-8063-d2c09ff2f4e8" />
</p>

### 7.3 Enabling Encryption

Now, navigate to the **Security** tab in the modal. If you haven't touched this before, the status will likely read "Not Encrypted." Let’s fix that immediately.

<p align="center">
<img height="500" alt="Security Tab" src="https://github.com/user-attachments/assets/f4df1115-e167-43d9-b814-0a27ce83aff1" />
</p>

Ah, much better.

You will notice a checkbox indicating **"Password stored in keyring"**. This is a crucial feature. It means your encryption password is saved securely in your Operating System's native password manager (e.g., GNOME Keyring, Windows Credential Manager, macOS Keychain), rather than in some flimsy JSON file that anyone can read.

From this tab, you can also:

* **Change the Password:** If you feel your current password has been compromised.
* **Remove Encryption:** If you decide you enjoy living dangerously (not recommended).

Your configuration is now encrypted. You may proceed with your digital life, secure in the knowledge that your school notes are safe from everyone including, most likely, yourself.

---

### Related Documentation

Now that your remote is securely established, you may want to learn how to actually use it.

* [Sync and Transfer](https://github.com/Zarestia-Dev/rclone-manager/wiki/Sync-and-Transfer)
* [Mounting](https://github.com/Zarestia-Dev/rclone-manager/wiki/Mounting)
* [Scheduler](https://github.com/Zarestia-Dev/rclone-manager/wiki/Scheduler)
* [Troubleshooting](https://github.com/Zarestia-Dev/rclone-manager/wiki/Troubleshooting)
