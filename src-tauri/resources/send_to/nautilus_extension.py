import subprocess
import urllib.parse
from gi.repository import Nautilus, GObject
from typing import List

class {class_name}(GObject.GObject, Nautilus.MenuProvider):
	def __init__(self):
		super().__init__()

	def menu_activate_cb(self, menu, files):
		exec_path = "{exec_path}".strip('"')
		if exec_path.startswith("flatpak "):
			args = exec_path.split() + ["--send-to-remote", "{remote}", "--send-to-path", "{path}"]
		else:
			args = [exec_path, "--send-to-remote", "{remote}", "--send-to-path", "{path}"]
		for f in files:
			uri = f.get_uri()
			if uri.startswith("file://"):
				path = urllib.parse.unquote(uri[7:])
				args.append(path)
		subprocess.Popen(args)

	def get_file_items(self, files):
		if not files:
			return []

		import os
		lang = os.environ.get("LANG", "en")[:2]
		labels = {
			"tr": "{name} Konumuna Yükle",
			"es": "Subir a {name}",
			"fr": "Transférer vers {name}",
			"uk": "Вивантажити до {name}",
			"zh": "上传至 {name}"
		}
		label_str = labels.get(lang, "Upload to {name}")

		tips = {
			"tr": "Seçili ögeleri RClone Yöneticisi kullanarak yükle",
			"es": "Subir los elementos seleccionados usando RClone Manager",
			"fr": "Transférer les éléments sélectionnés à l'aide de RClone Manager",
			"uk": "Вивантажити вибрані елементи за допомогою RClone Manager",
			"zh": "使用 RClone Manager 上传选中项"
		}
		tip_str = tips.get(lang, "Upload selected items using RClone Manager")

		item = Nautilus.MenuItem(
			name="RCloneManager::Upload_{uuid}",
			label=label_str,
			tip=tip_str
		)
		item.connect("activate", self.menu_activate_cb, files)
		return [item]

	def get_background_items(self, current_folder):
		return []
