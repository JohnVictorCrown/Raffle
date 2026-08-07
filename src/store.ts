import { detectLanguage, type Language } from "./i18n";

type Listener = (lang: Language) => void;

class Store {
  private _lang: Language = detectLanguage();
  private listeners: Listener[] = [];

  get state() {
    return { lang: this._lang };
  }

  get lang(): Language {
    return this._lang;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== fn);
    };
  }

  setLang(lang: Language) {
    this._lang = lang;
    for (const fn of this.listeners) {
      try {
        fn(lang);
      } catch (e) {
        console.error(e);
      }
    }
  }
}

export const store = new Store();