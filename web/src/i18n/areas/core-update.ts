// F24: what the window says when the running core is older than it (api.ts `refusalText`, chrome/CoreKept.tsx).
declare module '../index' {
  interface AreaKeys {
    'core.tooOld': true;
    'core.kept': true;
    'core.foreign': true;
  }
}

export const en = {
  "core.tooOld": "The background service is older than this window, so this cannot run yet. To fix it, run nunchiro serve restart in a Nunchiro terminal. The restart keeps terminals running. It ends chats, queued messages, sign-ins and sandbox runs.",
  "core.kept": "Nunchiro is updated, but the old background service still runs. Replacing it now would lose running chats, queued messages, sign-ins, sandbox runs or older terminals. The update finishes by itself when these end.",
  "core.foreign": "This window does not update or stop the background service it uses. Quit all only closes the window; agents keep running. The reason is in logs/core.log.",
};

export const ko = {
  "core.tooOld": "Nunchiro 백그라운드 서비스가 이 창보다 오래되어 아직 실행할 수 없습니다. 해결하려면 Nunchiro 터미널에서 nunchiro serve restart를 실행하세요. 다시 시작해도 터미널은 계속 실행되지만 채팅, 대기 중인 메시지, 로그인, 샌드박스 실행은 종료됩니다.",
  "core.kept": "Nunchiro가 업데이트되었지만 이전 백그라운드 서비스가 아직 실행 중입니다. 지금 교체하면 실행 중인 채팅, 대기 중인 메시지, 로그인, 샌드박스 실행 또는 이전 터미널이 사라집니다. 이 작업들이 끝나면 업데이트가 자동으로 완료됩니다.",
  "core.foreign": "이 창은 자신이 사용하는 백그라운드 서비스를 업데이트하거나 중지하지 않습니다. 종료해도 창만 닫히고 에이전트는 계속 실행됩니다. 이유는 logs/core.log에 있습니다.",
};

export const ja = {
  "core.tooOld": "Nunchiro のバックグラウンドサービスがこのウィンドウより古いため、まだ実行できません。解決するには、Nunchiro のターミナルで nunchiro serve restart を実行してください。再起動してもターミナルは動き続けますが、チャット、キュー内のメッセージ、ログイン、サンドボックスの実行は終了します。",
  "core.kept": "Nunchiro はアップデートされましたが、古いバックグラウンドサービスがまだ動いています。今置き換えると、実行中のチャット、キュー内のメッセージ、ログイン、サンドボックスの実行、または古いターミナルが失われます。これらが終わるとアップデートは自動で完了します。",
  "core.foreign": "このウィンドウは、使っているバックグラウンドサービスを更新も停止もしません。終了してもウィンドウが閉じるだけで、エージェントは動き続けます。理由は logs/core.log にあります。",
};

export const zhHans = {
  "core.tooOld": "Nunchiro 的后台服务比此窗口旧，暂时无法执行此操作。要解决此问题，请在 Nunchiro 终端中运行 nunchiro serve restart。重新启动后终端会继续运行，但聊天、排队的消息、登录和沙盒运行会结束。",
  "core.kept": "Nunchiro 已更新，但旧的后台服务仍在运行：现在替换会丢失正在运行的聊天、排队的消息、登录、沙盒运行或旧终端。这些结束后，更新会自动完成。",
  "core.foreign": "此窗口不会更新或停止它使用的后台服务。退出只会关闭窗口，代理会继续运行。原因见 logs/core.log。",
};

export const zhHant = {
  "core.tooOld": "Nunchiro 的背景服務比此視窗舊，暫時無法執行此操作。若要解決此問題，請在 Nunchiro 終端中執行 nunchiro serve restart。重新啟動後終端會繼續執行，但聊天、排隊的訊息、登入和沙箱執行會結束。",
  "core.kept": "Nunchiro 已更新，但舊的背景服務仍在執行：現在替換會遺失執行中的聊天、排隊的訊息、登入、沙箱執行或舊終端。這些結束後，更新會自動完成。",
  "core.foreign": "此視窗不會更新或停止它使用的背景服務。結束只會關閉視窗，代理會繼續執行。原因請見 logs/core.log。",
};

export const es = {
  "core.tooOld": "El servicio en segundo plano de Nunchiro es más antiguo que esta ventana, así que esto aún no puede ejecutarse. Para solucionarlo, ejecuta nunchiro serve restart desde un terminal de Nunchiro. Al reiniciar, los terminales siguen en marcha, pero se cierran los chats, los mensajes en cola, los inicios de sesión y las ejecuciones en sandbox.",
  "core.kept": "Nunchiro se actualizó, pero el servicio en segundo plano anterior sigue en marcha. Reemplazarlo ahora haría perder chats en curso, mensajes en cola, inicios de sesión, ejecuciones en sandbox o terminales antiguos. La actualización se completará sola cuando terminen.",
  "core.foreign": "Esta ventana no actualiza ni detiene el servicio en segundo plano que usa. Al salir solo se cierra la ventana; los agentes siguen en marcha. El motivo está en logs/core.log.",
};

export const fr = {
  "core.tooOld": "Le service d’arrière-plan de Nunchiro est plus ancien que cette fenêtre : cette action ne peut pas encore s’exécuter. Pour régler le problème, lancez nunchiro serve restart depuis un terminal Nunchiro. Lors d’un redémarrage, les terminaux continuent, mais les conversations, les messages en attente, les connexions et les exécutions en bac à sable prennent fin.",
  "core.kept": "Nunchiro a été mis à jour, mais l’ancien service d’arrière-plan tourne encore : le remplacer maintenant ferait perdre une conversation en cours, un message en attente, une connexion, une exécution en bac à sable ou un ancien terminal. La mise à jour s’achèvera d’elle-même une fois ceux-ci terminés.",
  "core.foreign": "Cette fenêtre ne met pas à jour et n’arrête pas le service d’arrière-plan qu’elle utilise. Tout quitter ne ferme que la fenêtre ; les agents continuent de tourner. La raison est dans logs/core.log.",
};

export const pt = {
  "core.tooOld": "O serviço em segundo plano do Nunchiro é mais antigo que esta janela, por isso isto ainda não pode ser executado. Para resolver, execute nunchiro serve restart a partir de um terminal do Nunchiro. Ao reiniciar, os terminais continuam em execução, mas as conversas, as mensagens em fila, os logins e as execuções em sandbox terminam.",
  "core.kept": "O Nunchiro foi atualizado, mas o serviço em segundo plano antigo ainda está em execução: substituí-lo agora perderia uma conversa em andamento, uma mensagem em fila, um login, uma execução em sandbox ou um terminal antigo. A atualização será concluída sozinha quando terminarem.",
  "core.foreign": "Esta janela não atualiza nem encerra o serviço em segundo plano que usa. Sair só fecha a janela; os agentes continuam em execução. O motivo está em logs/core.log.",
};
