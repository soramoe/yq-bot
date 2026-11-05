Option Explicit
' Hidden launcher for the Node service.
' stdout/stderr are appended to logs\service.out.log.
Dim sh, fso, root, cmd
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
cmd = "cmd /c node """ & root & "\server\main.mjs"" >> """ & root & "\logs\service.out.log"" 2>&1"
sh.CurrentDirectory = root
sh.Run cmd, 0, False
