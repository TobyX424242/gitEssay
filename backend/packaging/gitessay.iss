; gitEssay Windows installer (Inno Setup 6, preinstalled on windows-latest CI
; runners). Driven by scripts/build_desktop.py, which passes:
;   ISCC.exe /DAppVersion=<v> /DSourceDir=<abs dist\gitessay>
;            /DIconFile=<abs assets\icon.ico> /DOutputDir=<abs dist>
;            /DOutputName=gitessay-<v>-windows-x64-setup
;     backend\packaging\gitessay.iss
#ifndef AppVersion
  #define AppVersion "dev"
#endif
#ifndef SourceDir
  #define SourceDir "..\dist\gitessay"
#endif
#ifndef IconFile
  #define IconFile "..\assets\icon.ico"
#endif
#ifndef OutputDir
  #define OutputDir "..\dist"
#endif
#ifndef OutputName
  #define OutputName "gitessay-setup"
#endif

[Setup]
; Stable AppId: upgrades reinstall into the same directory and share one
; uninstall entry. Do NOT change once released.
AppId={{7E3A9C2E-5B1F-4D8A-9E6C-2F4B8A1D3C5E}
AppName=gitEssay
AppVersion={#AppVersion}
AppPublisher=gitEssay
AppComments=Local-first AI academic-writing surface
; Per-user install: no UAC prompt, no admin rights needed.
PrivilegesRequired=lowest
DefaultDirName={localappdata}\Programs\gitEssay
DefaultGroupName=gitEssay
OutputDir={#OutputDir}
OutputBaseFilename={#OutputName}
SetupIconFile={#IconFile}
UninstallDisplayIcon={app}\gitessay.exe
WizardStyle=modern
Compression=lzma2/ultra64
SolidCompression=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
; Close a running gitEssay gracefully before upgrading over it.
CloseApplications=yes
RestartApplications=no

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"; GroupDescription: "Additional shortcuts:"

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\gitEssay"; Filename: "{app}\gitessay.exe"
Name: "{group}\Uninstall gitEssay"; Filename: "{uninstallexe}"
Name: "{autodesktop}\gitEssay"; Filename: "{app}\gitessay.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\gitessay.exe"; Description: "Launch gitEssay"; Flags: nowait postinstall skipifsilent
