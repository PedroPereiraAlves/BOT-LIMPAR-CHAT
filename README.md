# Bot Limpar Chat

Bot do Discord que apaga o histórico de um canal específico. Só funciona em servidores, e só quem tem **Gerenciar mensagens** no canal consegue usar o comando.

## O que o comando faz

`/limpar` pede confirmação e oferece dois modos:

- **Recriar canal** — cria um canal novo com o mesmo nome, categoria, permissões e posição, e apaga o antigo. O histórico some na hora. O canal fica com outro ID, então webhooks e integrações ligadas ao ID antigo param de funcionar.
- **Apagar mensagens** — apaga as mensagens e os tópicos, mantendo o mesmo canal e o mesmo ID. Mensagens com mais de 14 dias são apagadas uma por uma, então um histórico grande pode levar bastante tempo. O bot precisa continuar ligado até o fim.

O Discord não deixa apagar em lote mensagens com mais de 14 dias. Por isso a limpeza completa e imediata é recriar o canal.

Depois de cada limpeza, o bot registra quem executou o comando. Se o servidor ainda não tiver um canal de texto chamado `auditoria`, ele cria esse canal. Quem tem cargo de administrador consegue ver o registro. O cargo @everyone não vê.

## Requisitos

- [Node.js 18](https://nodejs.org/) ou mais novo
- Um servidor do Discord em que você possa adicionar bots

## Criar o bot

1. Abra o [Portal do desenvolvedor](https://discord.com/developers/applications) e clique em **New Application**.
2. Em **Bot**, clique em **Reset Token**, confirme e copie o token.
3. Não é preciso ativar intents privilegiados.
4. Em **OAuth2 > URL Generator**, marque os escopos `bot` e `applications.commands`.
5. Marque as permissões **View Channels**, **Send Messages**, **Read Message History**, **Manage Messages**, **Manage Channels** e **Manage Threads**.
6. Abra o link gerado e adicione o bot ao servidor.

O ID da aplicação fica em **General Information**, no campo **Application ID**.

Para pegar o ID do servidor, ative o Modo desenvolvedor em **Configurações do usuário > Avançado** e use **Copiar ID do servidor** com o botão direito no ícone do servidor.

## Configurar

Na pasta do projeto:

```powershell
copy .env.example .env
npm install
```

Edite o `.env`:

```
DISCORD_TOKEN=cole_o_token_do_bot
CLIENT_ID=cole_o_id_da_aplicacao
GUILD_ID=cole_o_id_do_servidor
```

`GUILD_ID` faz o comando `/limpar` aparecer na hora. Sem ele, o comando é global e pode levar até 1 hora para surgir.

## Rodar

```powershell
npm start
```

Deixe esse terminal aberto enquanto o bot estiver limpando um canal. Ao conectar, ele mostra o link de convite, caso o bot ainda não esteja no servidor.

## Usar

No canal que você quer limpar, ou apontando para outro canal:

```
/limpar canal:#geral modo:Recriar canal (apaga tudo na hora)
/limpar modo:Apagar mensagens (mantém o canal)
```

Confirme no botão. Só quem executou o comando pode confirmar, e a confirmação expira em 60 segundos.

Canais de voz e tópicos só aceitam o modo **Apagar mensagens**. Canais de regras e de atualizações da comunidade não podem ser recriados.

## Limites

- O bot não lê conversas privadas e não apaga DMs.
- Recriar o canal muda o ID. Pins e webhooks não são copiados.
- No modo de apagar mensagens, o Discord limita a velocidade. Históricos muito antigos demoram.
- Algumas mensagens de sistema não podem ser apagadas. O bot informa quantas ficaram.

## Deixar ligado sem o seu PC

O bot precisa de um computador que fique ligado o tempo todo. Pode ser uma hospedagem de bots, como a [Square Cloud](https://squarecloud.app/) ou a [Discloud](https://discloud.com/), ou um VPS com Node.js.

1. Pare o `npm start` no seu PC. O mesmo token não pode ficar conectado nos dois lugares ao mesmo tempo.
2. Envie o projeto para a hospedagem, sem a pasta `node_modules`.
3. Cadastre lá as mesmas variáveis do `.env`: `DISCORD_TOKEN`, `CLIENT_ID` e `GUILD_ID`.
4. O comando de início é `npm start` e o arquivo principal é `src/index.js`.
5. Quando o painel mostrar o bot online, teste `/limpar` em um canal de teste.

Não publique o arquivo `.env` num repositório público. O token do bot é a senha dele.
