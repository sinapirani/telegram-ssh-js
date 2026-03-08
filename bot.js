// @ts-check
const TelegramBot = require("node-telegram-bot-api");
const fs = require("fs");
const { Client } = require("ssh2");
const yargs = require("yargs/yargs");
const { hideBin } = require("yargs/helpers");
const {
  isBotCommand,
  validateServerData,
  parseInput,
  pingHost,
} = require("./helper");
var exec = require("child_process").exec;

/**
 * @typedef {Object} CliArgs
 * @property {string} bot_token - Telegram bot token
 * @property {string} chat_id - Telegram chat ID
 * @property {string} owner_ids - Comma-separated list of owner chat IDs
 * @property {string|undefined} path_privatekey - Path to SSH private key
 * @property {string} servers_file - Path to servers JSON file
 * @property {number} max_retry - Maximum number of SSH connection retries
 */

/** @type {CliArgs} */
const argv = yargs(hideBin(process?.argv))
  .option("bot_token", {
    alias: "b",
    describe: "Telegram bot token",
    type: "string",
    demandOption: true,
  })
  .option("chat_id", {
    alias: "c",
    describe: "Telegram chat ID",
    type: "string",
    demandOption: true,
  })
  .option("owner_ids", {
    alias: "o",
    describe: "Comma-separated list of owner chat IDs",
    type: "string",
    demandOption: true,
  })
  .option("path_privatekey", {
    alias: "p",
    describe: "Path to SSH private key (optional if using password auth)",
    type: "string",
    demandOption: false,
  })
  .option("servers_file", {
    alias: "s",
    describe: "Path to servers JSON file",
    type: "string",
    demandOption: true,
    default: `${process.env.HOME}/.telegram-ssh/servers.json`,
  })
  .option("max_retry", {
    alias: "m",
    describe: "Maximum number of SSH connection retries",
    type: "number",
    demandOption: false,
    default: 3,
  })
  .parseSync();

const TOKEN = argv?.bot_token,
  CHAT_ID = argv?.chat_id,
  OWNER_IDS = argv?.owner_ids?.split(","),
  PATH_PRIVATEKEY = argv?.path_privatekey,
  SERVERS_FILE = argv?.servers_file;

//
console.log({ TOKEN, CHAT_ID, OWNER_IDS, PATH_PRIVATEKEY, SERVERS_FILE });

const DEFAULT_PATH = `${process.env.HOME}/.telegram-ssh-js`;
if (!fs.existsSync(DEFAULT_PATH)) {
  fs.mkdirSync(DEFAULT_PATH);
}

// Load the servers from the JSON file
let servers = [];
let current = null;

if (fs.existsSync(SERVERS_FILE)) {
  let serversFromFile = JSON.parse(fs.readFileSync(SERVERS_FILE, "utf8"));
  servers = serversFromFile.filter(validateServerData);

  if (servers.length !== serversFromFile.length) {
    fs.writeFileSync(SERVERS_FILE, JSON.stringify(servers, null, 2), "utf8");
    console.log("Removed invalid server entries from servers.json");
  }
} else {
  fs.writeFileSync(SERVERS_FILE, "[]", "utf8");
  servers = [];
}

// Connect to the SSH server using ssh2
const ssh = new Client();
let pwd = "~";

// Retry mechanism state
let retryCount = 0;
let retryTimeout = null;
let isExiting = false;
const MAX_RETRY = argv?.max_retry || 3;

ssh.on("ready", async () => {
  retryCount = 0; // Reset retry count on successful connection
  await bot.sendMessage(CHAT_ID, "SSH successfully connected.");
});

ssh.on("error", async (err) => {
  console.log("SSH connection error:", err.message);

  // Don't retry if user initiated exit
  if (isExiting) {
    return;
  }

  // Check if we've exhausted retries
  if (retryCount >= MAX_RETRY) {
    await bot.sendMessage(
      CHAT_ID,
      `SSH connection failed after ${MAX_RETRY} attempts. Last error: ${err.message}`,
      { disable_web_page_preview: true },
    );
    current = null;
    retryCount = 0;
    return;
  }

  retryCount++;
  await bot.sendMessage(
    CHAT_ID,
    `SSH connection failed (attempt ${retryCount}/${MAX_RETRY}). Retrying in 5 seconds...`,
    { disable_web_page_preview: true },
  );

  // Schedule retry
  retryTimeout = setTimeout(() => {
    if (!isExiting && current) {
      connectToSSH(current);
    }
  }, 5000);
});

ssh.on("close", async () => {
  console.log("SSH connection closed");

  // Don't retry if user initiated exit
  if (isExiting) {
    isExiting = false;
    return;
  }

  // Check if we've exhausted retries
  if (retryCount >= MAX_RETRY) {
    await bot.sendMessage(
      CHAT_ID,
      `SSH connection closed. Max retries (${MAX_RETRY}) reached.`,
      { disable_web_page_preview: true },
    );
    current = null;
    retryCount = 0;
    return;
  }

  // Only retry if we have a current server and not exiting
  if (current && retryCount < MAX_RETRY) {
    retryCount++;
    await bot.sendMessage(
      CHAT_ID,
      `SSH connection closed (attempt ${retryCount}/${MAX_RETRY}). Retrying in 5 seconds...`,
      { disable_web_page_preview: true },
    );

    retryTimeout = setTimeout(() => {
      if (!isExiting && current) {
        connectToSSH(current);
      }
    }, 5000);
  }
});

/**
 * Connect to SSH server with the given server configuration
 * @param {Object} serverConfig - Server configuration object
 */
function connectToSSH(serverConfig) {
  const sshConfig = {
    host: serverConfig?.host,
    username: serverConfig?.username,
    port: +serverConfig?.port || 22,
  };

  // Check for private key authentication
  const pathPrivateKey = serverConfig?.pathPrivateKey || PATH_PRIVATEKEY;
  if (pathPrivateKey) {
    try {
      sshConfig.privateKey = fs.readFileSync(pathPrivateKey);
      // Add passphrase for encrypted private key if provided
      if (serverConfig?.keypass) {
        sshConfig.passphrase = serverConfig.keypass;
      }
    } catch (error) {
      console.log(
        `Private key not found: ${pathPrivateKey}, trying password auth`,
      );
    }
  }

  // Add password authentication if available
  if (serverConfig?.password) {
    sshConfig.password = serverConfig.password;
  }

  ssh.connect(sshConfig);
}

const sshExecute = (command, ping) => {
  const cmd = `cd ${pwd} && ${command}`;

  ssh.exec(cmd, (err, stream) => {
    let result = "";

    if (err) {
      result = `${{ name: err.name, message: err.message, stack: err.stack }}`;
      console.log(err);
    }

    stream.on("data", (data) => {
      result += data.toString();
    });

    stream.on("close", async (code, signal) => {
      // save pwd
      if (command.includes("cd ")) {
        pwd = command.split("cd ")[1];
      }
      if (ping) {
        await bot.editMessageText(
          `<b>${current?.username}:${current?.host}\n${pwd}# ${command}</b>\n${
            result || pwd
          }`,
          {
            message_id: ping.message_id,
            chat_id: ping.chat.id,
            parse_mode: "HTML",
          },
        );
      } else {
        await bot.sendMessage(
          CHAT_ID,
          `<b>${current?.username}:${current?.host}\n${pwd}# ${command}</b>\n${
            result || pwd
          }`,
          {
            parse_mode: "HTML",
          },
        );
      }
    });
  });
};

const bot = new TelegramBot(TOKEN, { polling: true });

async function checkOwner(msg) {
  if (!OWNER_IDS.includes(String(msg.chat.id))) {
    await bot.sendMessage(
      CHAT_ID,
      `Unauthorized access\n${JSON.stringify(msg)}`,
    );
    return false;
  }
  return true;
}

bot.getMe().then((res) => {
  console.log(JSON.stringify(res, null, 2));
  bot.sendMessage(CHAT_ID, "Hello there");
});

bot
  .setMyCommands([
    { command: "add", description: "Add a new server /add root@10.10.1.1" },
    { command: "list", description: "List servers" },
    { command: "current", description: "Current server" },
    { command: "rm", description: "Remove server" },
    { command: "ssh", description: "/ssh index | /ssh root@10.10.1.1" },
    { command: "exit", description: "Exit" },
    { command: "cmd", description: "Run a command on the connected server" },
  ])
  .then((res) => {
    console.log("setMyCommands", res);
  });

//
bot.onText(/\/cmd (.+)/, async (msg, match) => {
  const o = await checkOwner(msg);
  if (!o) {
    return;
  }
  if (!match) {
    await bot.sendMessage(CHAT_ID, "Invalid command args.", {
      disable_web_page_preview: true,
    });
    return;
  }

  try {
    const command = match[1];
    exec(command, async function (error, stdout, stderr) {
      console.log({ error, stdout, stderr });

      if (stderr) {
        await bot.sendMessage(CHAT_ID, `stderr: ${stderr}`);
        return;
      }

      if (error) {
        await bot.sendMessage(
          CHAT_ID,
          `error: ${JSON.stringify(error, null, 2)}`,
        );
        return;
      }

      console.log(stdout);
      await bot.sendMessage(CHAT_ID, "stdout:\n" + stdout);
    });
  } catch (error) {
    await bot.sendMessage(CHAT_ID, `Error: ${JSON.stringify(error, null, 2)}`);
  }
});

// CRUD
bot.onText(/\/list/, async (msg) => {
  const o = await checkOwner(msg);
  if (!o) {
    return;
  }

  let message = `List of Servers (${servers.length}):\n`;
  if (servers.length > 0) {
    servers.forEach((s, i) => {
      message += `${i + 1}: ${s.username}@${s.host}:${s.port} ${
        s.note ? `(${s?.note})` : ""
      }\n`;
    });
  } else {
    message +=
      "No servers found. To add a new server, use the following command format:\n\n" +
      "/add user@host -p port -n note -pri /path/to/private/key -pass password\n\n" +
      "Example:\n" +
      "/add root@10.1.1.1 -p 22 -n 'wallet server' -pri /home/.ssh/id_rsa -pass 'your_password'";
  }

  await bot.sendMessage(CHAT_ID, message, {
    disable_web_page_preview: true,
  });
});

bot.onText(/\/current/, async (msg) => {
  const o = await checkOwner(msg);
  if (!o) {
    return;
  }
  if (!current) {
    await bot.sendMessage(
      CHAT_ID,
      `No server connected. Please connect to a server first.`,
    );
    return;
  }
  await bot.sendMessage(
    CHAT_ID,
    `Current: ${current.username}@${current.host}:${current.port}`,
    {
      disable_web_page_preview: true,
      protect_content: true,
    },
  );
});

bot.onText(/\/add (.+)/, async (msg, match) => {
  const o = await checkOwner(msg);
  if (!o) {
    return;
  }
  if (!match) {
    await bot.sendMessage(CHAT_ID, "Invalid command args.", {
      disable_web_page_preview: true,
    });
    return;
  }

  const input = match[1].trim();

  const { _args, ...data } = parseInput(input, {
    password: "-pass",
    port: "-p",
    note: "-n",
    pathPrivateKey: "-pri",
    keyPassword: "-keypass",
  });

  if (!_args[0]) {
    await bot.sendMessage(
      CHAT_ID,
      "Invalid format.\nUse /add user@host -p port -pass password -n note -pri /path/to/private/key -keypass keypassword",
      {
        disable_web_page_preview: true,
        protect_content: true,
      },
    );
    return;
  }

  const userHost = _args[0]?.trim();
  const [username, host] = userHost.split("@");

  if (!username || !host) {
    await bot.sendMessage(
      CHAT_ID,
      "Invalid format. Ensure 'user@host' is correctly provided.",
      {
        disable_web_page_preview: true,
        protect_content: true,
      },
    );
    return;
  }

  // ping to host for testing connection
  try {
    await pingHost(host);
  } catch (error) {
    await bot.sendMessage(CHAT_ID, error?.message, {
      disable_web_page_preview: true,
    });
    return;
  }

  const resolvedPathPrivateKey = data?.pathPrivateKey || PATH_PRIVATEKEY;

  // Check if at least one authentication method is provided
  if (!resolvedPathPrivateKey && !data?.password) {
    await bot.sendMessage(
      CHAT_ID,
      "At least one of -pri (private key) or -pass (password) must be provided.",
      {
        disable_web_page_preview: true,
        protect_content: true,
      },
    );
    return;
  }

  // Validate private key file exists if provided
  if (resolvedPathPrivateKey && !fs.existsSync(resolvedPathPrivateKey)) {
    await bot.sendMessage(
      CHAT_ID,
      `Private key file not found: ${resolvedPathPrivateKey}`,
      {
        disable_web_page_preview: true,
      },
    );
    return;
  }

  // keypass requires a private key
  if (data?.keyPassword && !resolvedPathPrivateKey) {
    await bot.sendMessage(
      CHAT_ID,
      "-keypass requires a private key (-pri) to be provided.",
      {
        disable_web_page_preview: true,
      },
    );
    return;
  }

  const newServer = {
    host,
    username,
    password: data?.password,
    port: data?.port || "22",
    pathPrivateKey: resolvedPathPrivateKey,
    keypass: data?.keyPassword || "",
    note: data?.note || "",
    time: new Date(),
  };

  servers.push(newServer);

  fs.writeFileSync(SERVERS_FILE, JSON.stringify(servers, null, 2), "utf8");
  await bot.sendMessage(
    CHAT_ID,
    `Added ${username}@${host}:${newServer.port} successfully`,
    {
      disable_web_page_preview: true,
    },
  );
});

bot.onText(/\/rm (.+)/, async (msg, match) => {
  const o = await checkOwner(msg);
  if (!o) {
    return;
  }
  if (!match) {
    await bot.sendMessage(CHAT_ID, "Invalid command args.", {
      disable_web_page_preview: true,
    });
    return;
  }
  const sv = match[1].trim().toLowerCase();
  let find = null;
  const index = parseFloat(sv) - 1;
  find = servers[index];

  if (find) {
    servers = servers.filter((s, i) => i !== index);
    fs.writeFileSync(SERVERS_FILE, JSON.stringify(servers), "utf8");
    await bot.sendMessage(
      CHAT_ID,
      `Removed ${find.username}@${find.host}:${find.port} successfully`,
      {
        disable_web_page_preview: true,
        protect_content: true,
      },
    );
  } else {
    await bot.sendMessage(CHAT_ID, `${sv} is not valid`, {
      disable_web_page_preview: true,
      protect_content: true,
    });
  }
});

// SSH
bot.onText(/\/ssh (.+)/, async (msg, match) => {
  const o = await checkOwner(msg);
  if (!o) {
    return;
  }
  if (!match) {
    await bot.sendMessage(CHAT_ID, "Invalid command args.", {
      disable_web_page_preview: true,
    });
    return;
  }

  const sv = match[1].trim().toLowerCase();
  let find = null;
  if (sv.includes("@")) {
    find = servers.find((m) => `${m?.username}@${m?.host}` === sv);
  } else {
    const index = parseFloat(sv) - 1;
    find = servers[index];
  }

  if (find) {
    // Reset retry state for new connection
    retryCount = 0;
    isExiting = false;
    if (retryTimeout) {
      clearTimeout(retryTimeout);
      retryTimeout = null;
    }

    current = find;

    // Validate that at least one authentication method is available
    const pathPrivateKey = current?.pathPrivateKey || PATH_PRIVATEKEY;
    let hasPrivateKey = false;
    if (pathPrivateKey) {
      try {
        fs.readFileSync(pathPrivateKey);
        hasPrivateKey = true;
      } catch (error) {
        // Private key file not found
        console.log(
          `Private key not found: ${pathPrivateKey}, trying password auth`,
        );
      }
    }

    if (!hasPrivateKey && !current?.password) {
      await bot.sendMessage(
        CHAT_ID,
        "No authentication method available. Please provide either a password or private key.",
        {
          disable_web_page_preview: true,
          protect_content: true,
        },
      );
      current = null;
      return;
    }

    await bot.sendMessage(
      CHAT_ID,
      `Connecting to ${current.username}@${current.host}:${current.port}...`,
      {
        disable_web_page_preview: true,
        protect_content: true,
      },
    );
    connectToSSH(current);
  } else {
    await bot.sendMessage(CHAT_ID, `${sv} is not valid`, {
      disable_web_page_preview: true,
      protect_content: true,
    });
  }
});

bot.onText(/\/exit/, async (msg, match) => {
  const o = await checkOwner(msg);
  if (!o) {
    return;
  }

  // Set exit flag and clear any pending retry
  isExiting = true;
  if (retryTimeout) {
    clearTimeout(retryTimeout);
    retryTimeout = null;
  }
  retryCount = 0;
  current = null;

  try {
    ssh.end();
  } catch (error) {
    console.log("Error ending SSH connection:", error.message);
  }

  await bot.sendMessage(CHAT_ID, `Disconnected from the current server`, {
    disable_web_page_preview: true,
    protect_content: true,
  });
});

bot.on("text", async (msg) => {
  const o = await checkOwner(msg);
  if (!o || isBotCommand(msg)) {
    return;
  }

  if (!current) {
    await bot.sendMessage(
      CHAT_ID,
      `No server connected. Please connect to a server first.`,
    );
    return;
  }

  const ping = await bot.sendMessage(CHAT_ID, `Executing...`);

  try {
    if (!msg.text) {
      throw new Error("Command is invalid");
    }
    sshExecute(msg.text.trim(), ping);
  } catch (error) {
    console.log(error);
    await bot.editMessageText(`Error: ${JSON.stringify(error, null, 2)}`, {
      message_id: ping.message_id,
      chat_id: ping.chat.id,
    });
  }
});
