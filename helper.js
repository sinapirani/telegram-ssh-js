const { exec } = require("child_process");

const pingHost = async (host) => {
  console.log("pingHost", host);
  return true;
  // return new Promise((resolve, reject) => {
  //   exec(`ping -c 1 ${host.trim()}`, (error, stdout, stderr) => {
  //     if (error) {
  //       reject(new Error(`Ping host failed\n${stderr}`));
  //     } else {
  //       resolve(stdout);
  //     }
  //   });
  // });
};

const isBotCommand = (message) => {
  if (!message || !message.entities) {
    return false;
  }
  const botCommands = message.entities.filter(
    (entity) => entity.type === "bot_command",
  );
  return botCommands.length > 0;
};

const validateServerData = (server) => {
  if (typeof server === "string" || typeof server === "undefined") return false;
  return true;
};

const trimQuotes = (str) => {
  return str.replace(/^['"]+|['"]+$/g, "");
};

/**
 * @typedef {Object} ParseInputResult
 * @property {string[]} _args - The parsed arguments array
 * @property {string} [password] - The password value
 * @property {string} [port] - The port value
 * @property {string} [note] - The note value
 * @property {string} [pathPrivateKey] - The private key path value
 * @property {string} [keyPassword] - The key password/passphrase value
 */

/**
 * Parses input string to extract command arguments and options
 * @param {string} input - The input string to parse
 * @param {Object} [key] - The key-value mapping of option names to their flags
 * @returns {ParseInputResult} The parsed result object
 */
const parseInput = (
  input,
  key = {
    password: "-pass",
    port: "-p",
    note: "-n",
    pathPrivateKey: "-pri",
    keyPassword: "-keypass",
  },
) => {
  const arguments = input
    .trim()
    .split(/(?= -\w)/)
    .map((arg) => arg.trim());
  /** @type {ParseInputResult} */
  let data = { _args: [] };
  arguments.forEach((arg) => {
    Object.entries(key).forEach(([option, flag]) => {
      if (arg.startsWith(flag + " ")) {
        data[option] = trimQuotes(arg?.split(flag + " ")[1].trim());
      }
    });
  });

  return { ...data, _args: arguments };
};

module.exports = {
  isBotCommand,
  validateServerData,
  parseInput,
  pingHost,
};
