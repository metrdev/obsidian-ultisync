import { App, Notice, Platform, PluginSettingTab, Setting } from 'obsidian';
import UltiSyncPlugin from '../main';
import { DEFAULT_SETTINGS, DEFAULT_STATE, PersistedData } from '../types';
import { DeviceStore } from './DeviceStore';
import { scopedApp, ScopeGuard } from './ScopedVault';

interface BackupPreferences { enabled: boolean; lastSuccess: string | null; }
function vaultKey(app: App): string {
 return app.vault.adapter.getResourcePath('') + ':' + app.vault.configDir;
}
function secretPrefix(key: string): string {
 let hash = 2166136261;
 for (const c of key) hash = Math.imul(hash ^ c.charCodeAt(0),16777619);
 return 'personal-vault-sync-'+(hash>>>0).toString(36)+'-';
}
/** Fail closed rather than using upstream's plaintext-token fallback. */
function secureApp(app: App, key: string): App {
 const store = app.secretStorage;
 if (!store || !['getSecret','setSecret','listSecrets'].every(k => typeof Reflect.get(store,k)==='function')) {
  throw new Error('SecretStorage is unavailable; context synchronization is disabled.');
 }
 const prefix = secretPrefix(key);
 const secrets = {
  getSecret: (id: string) => store.getSecret(prefix+id),
  setSecret: (id: string,value: string) => {
   store.setSecret(prefix+id,value);
   if (store.getSecret(prefix+id) !== value) throw new Error('SecretStorage write failed.');
  },
  listSecrets: () => store.listSecrets().filter(id => id.startsWith(prefix)).map(id => id.slice(prefix.length)),
 };
 return new Proxy(app,{get(target,property) {
  if (property==='secretStorage') return secrets;
  const value: unknown = Reflect.get(target,property,target);
  return typeof value==='function' ? (...args: unknown[]) => {const result: unknown = Reflect.apply(value,target,args); return result;} : value;
 }});
}
export default class PersonalVaultSync extends UltiSyncPlugin {
 private device!: DeviceStore;
 private realApp!: App;
 private backup: BackupPreferences = {enabled:false,lastSuccess:null};
 private backupBusy = false;
 private backupStatus = 'Not run';
 private backupIndicator?: Setting;
 private lastBackupAttempt = 0;
 private contextReady = false;
 private persistence: Promise<void> = Promise.resolve();

 async onload(): Promise<void> {
  this.realApp = this.app;
  this.device = new DeviceStore(vaultKey(this.realApp));
  try {
   this.backup = await this.device.get<BackupPreferences>('backup') ?? this.backup;
   let guard: ScopeGuard = () => {
    if (!this.realApp.vault.getAbstractFileByPath('GPT')) throw new Error('GPT folder is not available.');
   };
   if (Platform.isDesktopApp) {
    const adapter = this.realApp.vault.adapter as unknown as {getBasePath():string};
    const {desktopBoundary} = await import('./DesktopBoundary');
    guard = await desktopBoundary(adapter.getBasePath());
   }
   this.app = scopedApp(secureApp(this.realApp,vaultKey(this.realApp)),guard);
   await super.onload();
   this.contextReady = true;
  } catch(error) {
   this.app = this.realApp;
   const message = error instanceof Error ? error.message : 'Local storage unavailable.';
   new Notice('Personal Vault Sync: '+message,12000);
   const renderBackup = (element: HTMLElement) => this.backupSettings(element);
   this.addSettingTab(new class extends PluginSettingTab {
    getSettingDefinitions() { return [{name:'Context unavailable',render:(setting: Setting) => {setting.setDesc(message); renderBackup(setting.settingEl);}}]; }
   }(this.realApp,this));
  }
  this.addCommand({id:'backup-now',name:'Back up vault now (desktop)',callback:() => {void this.runBackup(true);}});
  if (Platform.isDesktopApp) {
   this.registerInterval(window.setInterval(() => {void this.runBackup(false);},60000));
   this.realApp.workspace.onLayoutReady(() => {void this.runBackup(false);});
  }
 }
 onunload(): void {
  if (this.contextReady) super.onunload();
  // Finish outstanding IndexedDB transactions before closing on unload.
  void this.persistence.finally(() => this.device?.close());
 }
 async loadData(): Promise<unknown> {
  const selected = await this.device.get<string>('active-context');
  const stored = selected ? await this.device.get<PersistedData>('context:'+selected) : undefined;
  return stored ?? {schemaVersion:1,settings:{
   ...DEFAULT_SETTINGS, githubOwner:'metrdev',githubRepo:'personal-notes',branch:'main',syncEnabled:false,
  },state:structuredClone(DEFAULT_STATE)};
 }
 async saveData(value: PersistedData): Promise<void> {
  if (value.settings.token) throw new Error('Refusing to persist a plaintext token.');
  const repo = value.settings.githubOwner+'/'+value.settings.githubRepo+'#'+value.settings.branch;
  // Snapshot now: upstream mutates its live state while saves are queued.
  const snapshot = structuredClone(value);
  const save = this.persistence.catch(() => undefined).then(async () => {
   await this.device.put('context:'+repo,snapshot);
   await this.device.put('active-context',repo);
  });
  this.persistence = save;
  return save;
 }
 addSettingTab(tab: PluginSettingTab): void {
  const definitions = tab.getSettingDefinitions.bind(tab);
  tab.getSettingDefinitions = () => [
   {name:'Personal context',render:setting => {
    setting.setDesc('GPT/ plus exactly FamilyNotes/recipes.md ↔ personal-notes. State is local to this device; credentials require secure storage.');
   }},
   ...definitions(),
   {name:'Desktop backup',render:setting => this.backupSettings(setting.settingEl)},
  ];
  super.addSettingTab(tab);
 }
 private backupSettings(container: HTMLElement): void {
  const panel = container.createDiv();
  panel.setAttribute('data-personal-backup','true');
  new Setting(panel).setName('Vault backup').setHeading();
  panel.createEl('p',{text:Platform.isDesktopApp ?
   'Full backup via the existing Git repository. Once daily while Obsidian is open. Restore is manual.' :
   'Full backup is disabled on mobile. GPT synchronization works independently.'});
  if (!Platform.isDesktopApp) return;
  new Setting(panel).setName('Daily backup on this computer').setDesc('Enabled separately on each desktop. Default: off.')
   .addToggle(t => t.setValue(this.backup.enabled).onChange(async enabled => {
    this.backup.enabled=enabled;
    await this.device.put('backup',this.backup);
   }));
  this.backupIndicator = new Setting(panel).setName('Backup status').setDesc(this.backupStatus+'; last success: '+(this.backup.lastSuccess??'never'))
   .addButton(b => b.setButtonText('Back up now').onClick(async () => {await this.runBackup(true);}));
 }
 private async runBackup(manual: boolean): Promise<void> {
  if (!Platform.isDesktopApp || this.backupBusy || (!manual && !this.backup.enabled)) return;
  if (!manual && this.backup.lastSuccess && new Date(this.backup.lastSuccess).toDateString()===new Date().toDateString()) return;
  if (!manual && Date.now()-this.lastBackupAttempt < 15*60*1000) return;
  this.lastBackupAttempt=Date.now();
  this.backupBusy=true;
  try {
   const adapter=this.realApp.vault.adapter as unknown as {getBasePath():string};
   const {NativeBackup}=await import('./NativeBackup');
   const result=await new NativeBackup(adapter.getBasePath(),'metrdev/ObsidianGeneralNotes',this.realApp.vault.configDir).run();
   this.backup.lastSuccess=new Date().toISOString();
   this.backupStatus=result.changed?'Backup saved':'No changes; remote is current';
   await this.device.put('backup',this.backup);
   if(manual) new Notice(this.backupStatus);
  } catch(error) {
   this.backupStatus=error instanceof Error?error.message:'Backup failed.';
   new Notice('Personal Vault Sync: '+this.backupStatus,12000);
  } finally {
   this.backupBusy=false;
   this.backupIndicator?.setDesc(this.backupStatus+'; last success: '+(this.backup.lastSuccess??'never'));
  }
 }
}
