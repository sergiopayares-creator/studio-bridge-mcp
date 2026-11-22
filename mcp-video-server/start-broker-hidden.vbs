' Studio Bridge — arranca el broker en segundo plano (sin ventana).
' Útil para el inicio automático de Windows: pon un acceso directo a este
' archivo en  shell:startup  (Ejecutar > shell:startup).
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = scriptDir
shell.Run "node broker.js", 0, False
