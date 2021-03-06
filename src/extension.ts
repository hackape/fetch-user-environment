'use strict';
// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';

// Modules from Node.js
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Other libraries from npm
const fse = require('fs-extra');
const compareVer = require('semver-compare');
const stripJsonComments = require('strip-json-comments');

// Exception
function JSONError(message, filename) {
    this.message = message;
    this.filename = filename;
    this.stack = (new Error()).stack;
}

// Output messages
const fetchMsgChannel = vscode.window.createOutputChannel('Fetch User Environment');

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export async function activate(context: vscode.ExtensionContext) {
    // Get config
    var config = vscode.workspace.getConfiguration('fetchUserEnv');
    var remoteExtPath = config.get('remoteExtensionPath');
    var remoteSetPath = config.get('remoteSettingsPath');
    var remoteDefSetFile = config.get('remoteDefaultSettingsFilename');

    // New environment fetcher
    var environmentFetcher = new FetchEnvironment(remoteExtPath, remoteSetPath, remoteDefSetFile);

    // Register Commands
    let fetchExtDisposable = vscode.commands.registerCommand('fetchUserEnv.extensions', async function() {
        try {
            await environmentFetcher.fetchExtensions(true);
        } catch (err) {
            vscode.window.showErrorMessage('Failed to fetch extensions.');
            console.error(err);
        }
    });

    let fetchSetDisposable = vscode.commands.registerCommand('fetchUserEnv.settings', async function() {
        try {
            await environmentFetcher.fetchSettings(true);
        } catch (err) {
            vscode.window.showErrorMessage('Failed to fetch settings.');
            console.error(err);
        }
    });

    let saveEnvDisposable = vscode.commands.registerCommand('fetchUserEnv.saveEnvironment', async function() {
        try {
            await environmentFetcher.saveEnvironment();
        } catch (err) {
            vscode.window.showErrorMessage('Failed to save environment.');
            console.error(err);
        }
    });

    // Add to a list of disposables which are disposed when this extension is deactivated.
    context.subscriptions.push(fetchExtDisposable,
                                fetchSetDisposable,
                                saveEnvDisposable);

    // Clear messages
    fetchMsgChannel.clear();

    // Run automatically on start up.  Don't prompt the user if paths aren't configured.
    // Fetch extensions
    try {
        await environmentFetcher.fetchExtensions(false);
    } catch (err) {
        vscode.window.showErrorMessage('Failed to fetch extensions.');
        console.error(err);
    }

    // Fetch Settings
    try {
        await environmentFetcher.fetchSettings(false);
    } catch (err) {
        vscode.window.showErrorMessage('Failed to fetch settings.');
        console.error(err);
    }
}

// this method is called when your extension is deactivated
export function deactivate() {
}

class FetchEnvironment {
    private _localExtensionPath : string;
    private _remoteExtensionPath : string;
    private _localSettingsPath : string;
    private _remoteSettingsPath : string;
    private _remoteDefaultSettingsFilename : string;
    
    private _localExtVersions = {};

    constructor(remoteExtPath, remoteSetPath, remoteDefSetFile) {
        // Set remote paths and filenames
        this._remoteExtensionPath = remoteExtPath;
        this._remoteSettingsPath = remoteSetPath;
        this._remoteDefaultSettingsFilename = remoteDefSetFile;

        // Set local paths
        this.getLocalPaths();
    }

    private getLocalPaths() {
        // Path of installed extensions
        this._localExtensionPath = path.join(os.homedir(), '.vscode', 'extensions');

        // Path of environment settings
        if (os.platform() === 'win32') {
            this._localSettingsPath = path.join(process.env.APPDATA, 'Code', 'User');
        }
        if (os.platform() === 'darwin') {
            this._localSettingsPath = path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User');
        }
        if (os.platform() === 'linux') {
            this._localSettingsPath = path.join(os.homedir(), '.config', 'Code', 'User');
        }
    }

    private saveRemoteExtensionPath(path : string) {
        this._remoteExtensionPath = path;

        try {
            this.updateSettings({'fetchUserEnv.remoteExtensionPath' : this._remoteExtensionPath});
        }
        catch (err) {
            throw err;
        }
    }

    private saveRemoteSettingsPath(path : string) {
        this._remoteSettingsPath = path;

        try {
            this.updateSettings({'fetchUserEnv.remoteSettingsPath' : this._remoteSettingsPath});
        }
        catch (err) {
            throw err;
        }
    }

    private saveDefaultSettingsFilename(path : string) {
        this._remoteDefaultSettingsFilename = path;

        try {
            this.updateSettings({'fetchUserEnv.remoteDefaultSettingsFilename' : this._remoteDefaultSettingsFilename});
        }
        catch (err) {
            throw err;
        }
    }

    private async getRemoteExtensionPath() {
        let value = '';
        if (this._remoteExtensionPath) {
            value = this._remoteExtensionPath;
        }

        let options = {prompt: 'Please enter path for remote extensions',
                    ignoreFocusOut: true,
                    value: value};

        var path = await vscode.window.showInputBox(options);

        if (!path) {
            vscode.window.showWarningMessage('Path for remote extensions not specified, operation cancelled.');
            return false;
        }

        try {
            this.saveRemoteExtensionPath(path);
        }
        catch (err) {
            throw err;
        }

        return true;
    }

    private async getRemoteSettingsPath() {
        let value = '';
        if (this._remoteSettingsPath) {
            value = this._remoteSettingsPath;
        }

        let options = {prompt: 'Please enter path for remote settings',
                    ignoreFocusOut: true,
                    value: value};

        var path = await vscode.window.showInputBox(options);

        if (!path) {
            vscode.window.showWarningMessage('Path for remote settings not specified, operation cancelled.');
            return false;
        }

        try {
            this.saveRemoteSettingsPath(path);
        }
        catch (err) {
            throw err;
        }

        return true;
    }

    private async getDefaultSettingsFilename() {
        let value = '';
        if (this._remoteDefaultSettingsFilename) {
            value = this._remoteDefaultSettingsFilename;
        }

        let options = {prompt: 'Please enter default settings filename.',
                    ignoreFocusOut: true,
                    value: value};

        var filename = await vscode.window.showInputBox(options);

        if (!filename) {
            vscode.window.showWarningMessage('Filename for the default settings not specified, operation cancelled.');
            return false;
        }

        try {
            this.saveDefaultSettingsFilename(filename);
        }
        catch (err) {
            throw err;
        }

        return true;
    }

    public async fetchExtensions(prompt: boolean) {
        // Path validation
        let unconfirmed = true;
        let reenter = false;

        if (prompt) {
            // Clear messages
            fetchMsgChannel.clear();
        }

        while (unconfirmed) {
            if (!this._remoteExtensionPath || reenter) {
                if (!prompt && !reenter) {
                    return;
                }

                reenter = false;

                try {
                    if (!await this.getRemoteExtensionPath()) {
                        return;
                    }
                }
                catch (err) {
                    if (err instanceof JSONError) {
                        let message = 'Error detected in configuration file: "' + err.filename + '", ' + err.message;
                        vscode.window.showErrorMessage(message);
                        return;
                    }
                }
            }

            unconfirmed = !fs.existsSync(this._remoteExtensionPath);

            if (unconfirmed) {
                // Complain
                console.error('Specified remote extension path "' + this._remoteExtensionPath + '" does not exist');
                let pathAgainOption = {title: 'Try Again'};
                let pathReenterOption = {title: 'Reenter Path'};
                let pathIgnoreOption = {title: 'Ignore', isCloseAffordance: true};
                if (!await vscode.window.showErrorMessage('Cannot access extensions at specified remote path.', pathAgainOption, pathReenterOption, pathIgnoreOption)
                    .then(choice => {
                        switch (choice) {
                            case pathAgainOption:
                                break;
                            case pathReenterOption:
                                reenter = true;
                                break;
                            case pathIgnoreOption:
                                // Use default case and just exit
                            default:
                                return false;
                        }
                        return true;
                    })) {
                    return;
                }
            }
        }

        // Paths are valid, continue
        // Check versions of installed extensions
        this.getInstalledExtensions();

        try {
            // Compare local versions to remote, and copy newer versions
            if (this.installNewExtensions()) {
                // Extensions were updated, reload/restart required
                let reloadOption = {title: 'Reload'};
                vscode.window.showInformationMessage('Extensions updated, please restart Visual Studio Code or reload window', reloadOption)
                    .then(choice => {
                        if (choice === reloadOption) {
                            vscode.commands.executeCommand('workbench.action.reloadWindow');
                        }
                    });
            }
            else {
                if (prompt) {
                    vscode.window.showInformationMessage('Extensions are up to date');
                }
                console.log('No updated extensions found.');
                fetchMsgChannel.appendLine('No updated extensions found.');
            }
        }
        catch (err) {
            if (err instanceof JSONError) {
                let message = 'Error detected in extension package file: "' + err.filename + '", ' + err.message;
                vscode.window.showErrorMessage(message);
            }
            else {
                vscode.window.showErrorMessage('Failed to fetch extensions.');
            }
            console.error(err);
        }

        return;
    }

    public async fetchSettings(prompt: boolean) {
        // Path validation
        let unconfirmed = true;
        let reenter = false;

        if (prompt) {
            // Clear messages
            fetchMsgChannel.clear();
        }

        while (unconfirmed) {
            if (!this._remoteSettingsPath || reenter) {
                if (!prompt && !reenter) {
                    return;
                }

                reenter = false;

                try {
                    if (!await this.getRemoteSettingsPath()) {
                        return;
                    }
                }
                catch (err) {
                    if (err instanceof JSONError) {
                        let message = 'Error detected in configuration file: "' + err.filename + '", ' + err.message;
                        vscode.window.showErrorMessage(message);
                        return;
                    }
                }
            }

            unconfirmed = !fs.existsSync(path.join(this._remoteSettingsPath, 'settings.json'));

            if (unconfirmed) {
                // Complain
                console.error('"settings.json" does not exist in specified remote settings path "' + this._remoteSettingsPath + '"');
                let pathAgainOption = {title: 'Try Again'};
                let pathReenterOption = {title: 'Reenter Path'};
                let pathIgnoreOption = {title: 'Ignore', isCloseAffordance: true};
                if (!await vscode.window.showErrorMessage('Cannot access settings at specified remote path.', pathAgainOption, pathReenterOption, pathIgnoreOption)
                    .then(choice => {
                        switch (choice) {
                            case pathAgainOption:
                                break;
                            case pathReenterOption:
                                reenter = true;
                                break;
                            case pathIgnoreOption:
                                // Use default case and just exit
                            default:
                                return false;
                        }
                        return true;
                    })) {
                    return;
                }
            }
        }

        unconfirmed = true;
        reenter = false;
        let disable = false;
        while (unconfirmed)
        {
            unconfirmed = this._remoteDefaultSettingsFilename && (!fs.existsSync(path.join(this._remoteSettingsPath, this._remoteDefaultSettingsFilename)));

            if (unconfirmed) {
                // Complain
                console.error('Default settings file "' + this._remoteDefaultSettingsFilename + '" does not exist in specified remote settings path "' + this._remoteSettingsPath + '"');
                let defSetAgainOption = {title: 'Try Again'};
                let defSetReenterOption = {title: 'Reenter Filename'};
                let defSetIgnoreOption = {title: 'Ignore', isCloseAffordance: true};
                let defSetDisableOption = {title: 'Disable'};
                await vscode.window.showErrorMessage('Cannot access default settings at specified remote path.', defSetAgainOption, defSetReenterOption, defSetIgnoreOption, defSetDisableOption)
                    .then(choice => {
                        switch (choice) {
                            case defSetAgainOption:
                                break;
                            case defSetReenterOption:
                                reenter = true;
                                break;
                            case defSetDisableOption:
                                disable = true;
                                // The default settings are optional, no need to quit.
                                unconfirmed = false;
                                break;
                            case defSetIgnoreOption:
                                // Temporarily disable the default settings for the duration of the session
                                this._remoteDefaultSettingsFilename = null;
                                // Continue on to default...
                            default:
                                // The default settings are optional, no need to quit.
                                unconfirmed = false;
                                break;
                        }
                    });
            }

            if (reenter) {
                reenter = false;

                try {
                    // The default settings are optional, no need to quit if filename entry is aborted.
                    await this.getDefaultSettingsFilename();
                }
                catch (err) {
                    if (err instanceof JSONError) {
                        let message = 'Error detected in configuration file: "' + err.filename + '", ' + err.message;
                        vscode.window.showErrorMessage(message);
                        return;
                    }
                }
            }

            if (disable) {
                disable = false;

                try {
                    // Remove invalid config
                    this.saveDefaultSettingsFilename(null);
                }
                catch (err) {
                    if (err instanceof JSONError) {
                        // Not great, not the end of the world either.  Prompt but move on.
                        let message = 'Error detected in configuration file: "' + err.filename + '", ' + err.message;
                        vscode.window.showWarningMessage(message);
                    }
                }
            }
        }

        // Paths are valid, continue
        try {
            // Compare local settings to remote, update as required
            if (this.compareSettings()) {
                // Settings were updated, reload/restart required
                let reloadOption = {title: 'Reload'};
                vscode.window.showInformationMessage('Settings updated, please restart Visual Studio Code or reload window', reloadOption)
                    .then(choice => {
                        if (choice === reloadOption) {
                            vscode.commands.executeCommand('workbench.action.reloadWindow');
                        }
                    });
            }
            else {
                if (prompt) {
                    vscode.window.showInformationMessage('Settings are up to date');
                }
                console.log('No updated settings found.');
                fetchMsgChannel.appendLine('No updated settings found.');
            }
        }
        catch (err) {
            if (err instanceof JSONError) {
                let message = 'Error detected in configuration file: "' + err.filename + '", ' + err.message;
                vscode.window.showErrorMessage(message);
            }
            else {
                vscode.window.showErrorMessage('Failed to fetch settings.');
            }
            console.error(err);
        }

        return;
    }

    public async saveEnvironment() {
        try {
            if (!this._remoteExtensionPath) {
                if (!await this.getRemoteExtensionPath()) {
                    return;
                }
            }
        }
        catch (err) {
            if (err instanceof JSONError) {
                let message = 'Error detected in configuration file: "' + err.filename + '", ' + err.message;
                vscode.window.showErrorMessage(message);
                return;
            }
        }

        try {
            if (!this._remoteSettingsPath) {
                if (!await this.getRemoteSettingsPath()){
                    return;
                }
            }
        }
        catch (err) {
            if (err instanceof JSONError) {
                let message = 'Error detected in configuration file: "' + err.filename + '", ' + err.message;
                vscode.window.showErrorMessage(message);
                return;
            }
        }

        if (!fs.existsSync(this._remoteSettingsPath)) {
            // Path does not yet exist, create it
            fse.ensureDir(this._remoteSettingsPath, function (err) {
                if (err) return console.error(err);
            });
        }

        if (!fs.existsSync(this._remoteExtensionPath)) {
            // Path does not yet exist, create it
            fse.ensureDir(this._remoteExtensionPath, function (err) {
                if (err) return console.error(err);
            });
        }

        var settingsPath: string;
        var extensionPath: string;

        if (os.platform() === 'win32') {
            // Windows is case preserving, case insensitive
            // Convert to lowercase
            settingsPath = String(this._remoteSettingsPath).toLowerCase();
            extensionPath = String(this._remoteExtensionPath).toLowerCase();
        }
        else {
            settingsPath = String(this._remoteSettingsPath);
            extensionPath = String(this._remoteExtensionPath);
        }

        // Are the remote paths empty?  Count the number of items.
        var items = fs.readdirSync(settingsPath).length;
        items += fs.readdirSync(extensionPath).length;

        // Check if paths are nested.
        if ((settingsPath !== extensionPath)
            && (settingsPath.startsWith(extensionPath)
                || extensionPath.startsWith(settingsPath)))
        {
            // Nested, reduce item count.
            items -= 1;
        }

        if (items > 0) {
            vscode.window.showErrorMessage('Cannot save environment, remote paths are not empty.');
            return;
        }

        try {
            // Copy settings and extensions to remote locations
            this.copyEnvToRemote();
        }
        catch (err) {
            if (err instanceof JSONError) {
                let message = 'Error detected in configuration file: "' + err.filename + '", ' + err.message;
                vscode.window.showErrorMessage(message);
            }
            else {
                vscode.window.showErrorMessage('Failed to save environment.');
            }
            console.error(err);
        }

        try {
            // Hide command palette menu item
            this.updateSettings({'fetchUserEnv.palEnableSaveEnv' : false});
        }
        catch (err) {
            if (err instanceof JSONError) {
                // Not great, not the end of the world either.  Prompt but move on.
                let message = 'Error detected in configuration file: "' + err.filename + '", ' + err.message;
                vscode.window.showWarningMessage(message);
            }
        }
        
        vscode.window.showInformationMessage('Current environment saved.');
        return;
    }

    private compareSettings() {
        var updatedDefault;
        var updatedRemote;

        try {
            updatedDefault = this.compareDefaultSettings();
            updatedRemote = this.compareRemoteSettings();
        }
        catch (err) {
            throw err;
        }

        return updatedDefault || updatedRemote;
    }

    private compareDefaultSettings() {
        // Has a file containing optional defaults been configured?
        if (!this._remoteDefaultSettingsFilename) {
            // Nope, nothing to do.  We're done here.
            return false;
        }

        try {
            // Read default settings file
            var defaultSettings = this.readSettingsFile(path.join(this._remoteSettingsPath, this._remoteDefaultSettingsFilename));
        }
        catch (err) {
            throw err;
        }

        try {
            // Read local settings file (therefore ignoring the workspace) so default settings can be compared
            var localSettings = this.readSettingsFile(path.join(this._localSettingsPath, 'settings.json'));
        }
        catch (err) {
            throw err;
        }

        var updated: boolean = false;
        var newSettings = {};

        for (let prop in defaultSettings) {
            // Only add settings that are missing, ignore existing settings even if they are different
            if (!localSettings.hasOwnProperty(prop)) {
                newSettings[prop] = defaultSettings[prop];
                updated = true;
            }
        }

        if (updated) {
            // New settings were found
            let logStr = JSON.stringify(newSettings, null, 2);
            console.log('Adding default config parameters');
            console.log(logStr);
            fetchMsgChannel.show();
            fetchMsgChannel.appendLine('Adding default config parameters');
            fetchMsgChannel.appendLine(logStr);

            try {
                // Save settings
                this.updateSettings(newSettings);
            }
            catch (err) {
                throw err;
            }
        }
        return updated;
    }

    private compareRemoteSettings() {
        try {
            // Read remote settings file
            var remoteSettings = this.readSettingsFile(path.join(this._remoteSettingsPath, 'settings.json'));
        }
        catch (err) {
            throw err;
        }

        try {
            // Read local settings file (therefore ignoring the workspace) so remote settings can be compared
            var localSettings = this.readSettingsFile(path.join(this._localSettingsPath, 'settings.json'));
        }
        catch (err) {
            throw err;
        }

        var updated: boolean = false;
        var newSettings = {};

        for (let prop in remoteSettings) {
            let base = {};
            let compare = {};
            
            base[prop] = localSettings[prop];
            compare[prop] = remoteSettings[prop];
            
            // Returned object will have no properties if base & compare are the same
            let res = this.compareUpdate(base, compare);
            
            for (let key in res) {
                if (res.hasOwnProperty(key)) {
                    // Object has a property therefore a difference was found
                    // Add to list of required updates
                    Object.assign(newSettings, res);
                    updated = true;
                    
                    break;
                }
            }
        }

        if (updated) {
            // New settings were found
            let logStr = JSON.stringify(newSettings, null, 2);
            console.log('Updating config parameters');
            console.log(logStr);
            fetchMsgChannel.show();
            fetchMsgChannel.appendLine('Updating config parameters');
            fetchMsgChannel.appendLine(logStr);

            try {
                // Save settings
                this.updateSettings(newSettings);
            }
            catch (err) {
                throw err;
            }
        }
        return updated;
    }

    private compareUpdate(base: {}, compare: {}) {
        // Quick wins, look for items that have been added or removed
        // Are there nested items that need to be added?
        for (let prop in compare) {
            if ((typeof(base[prop]) === 'undefined')    // Property value within the initial base object is queried from the current environment and consequently may not actually exist.
                || (!base.hasOwnProperty(prop))) {
                // No need to keep searching
                return compare;
            }
        }
        // Are there nested items in the baseline that need to be removed?
        for (let prop in base) {
            if ((typeof(compare[prop]) === 'undefined') // Should be redundant but keep for consistency
                || (!compare.hasOwnProperty(prop))) {
                // No need to keep searching
                return compare;
            }
        }

        // Compare each item
        for (let prop in compare) {
            // Check if we need to dig deeper...
            if (typeof(compare[prop]) === 'object') {
                let diff = this.compareUpdate(base[prop] , compare[prop]);

                // Check if differences were found
                for (let key in diff) {
                    if (diff.hasOwnProperty(key)) {
                        // A difference was found, return entire object.
                        // Returning differences only will delete matching items
                        return compare;
                    }
                }
            }
            else if (base[prop] !== compare[prop]) {
                // A difference was found, return entire object.
                // Returning differences only will delete matching items
                return compare;
            }
        }

        // No differences, return empty object
        return {};
    }

    private getInstalledExtensions() {
        // Get all extensions and filter for those installed by the user
        var localExtensions = vscode.extensions.all.filter(ext => {
            return ext.extensionPath.startsWith(this._localExtensionPath);
        });
        
        // Query the version of each installed extension
        for (let ext in localExtensions) {
            this._localExtVersions[localExtensions[ext].id] = localExtensions[ext].packageJSON['version'];
        }
    }

    private installNewExtensions() {
        // Find all extensions at the remote path
        // Obtain list of all top level directories
        var folders = fs.readdirSync(this._remoteExtensionPath).filter(file => fs.statSync(path.join(this._remoteExtensionPath, file)).isDirectory());

        var updated: boolean = false;

        for (let folder in folders) {
            let packageFile = path.join(this._remoteExtensionPath, folders[folder], 'package.json');

            if (!fs.existsSync(packageFile)) {
                // Not a valid extension directory, skip
                continue;
            }

            // Query extension ID
            let json_file;

            try {
                json_file = JSON.parse(fs.readFileSync(packageFile, 'UTF-8'));
            }
            catch (err) {
                throw new JSONError(err.message, packageFile);
            }

            let id = json_file['publisher'] + '.' + json_file['name'];
            let version = json_file['version'];

            if (typeof this._localExtVersions[id] !== 'undefined') {
                if (compareVer(this._localExtVersions[id], version) >= 0) {
                    // Correct version, move along
                    continue;
                }
            }

            // Missing or old version, copy from remote source.
            // No need to remove old version, VS Code will do that automatically upon restart
            console.log('Updating extension "' + id + '" to version ' + version);
            fetchMsgChannel.show();
            fetchMsgChannel.appendLine('Updating extension "' + id + '" to version ' + version);
            let srcPath = path.join(this._remoteExtensionPath, folders[folder]);
            let dstPath = path.join(this._localExtensionPath, id + '-' + version);
            fse.copy(srcPath, dstPath, function (err) {
                if (err) return console.error(err);
            });
            updated = true;
        }

        return updated;
    }

    private copyEnvToRemote() {
        try {
            // Copy settings
            // Read and filter local settings file so it can be saved
            var localSettings = this.readSettingsFile(path.join(this._localSettingsPath, 'settings.json'));
        }
        catch (err) {
            throw err;
        }

        // Save to remote
        var remoteSettingsJSON = JSON.stringify(localSettings, null, 2);
        fs.writeFileSync(path.join(this._remoteSettingsPath, 'settings.json'), remoteSettingsJSON, {encoding: 'UTF-8'});

        // Copy extensions
        // Get all extensions and filter for those installed by the user
        var localExtensions = vscode.extensions.all.filter(ext => {
            return ext.extensionPath.startsWith(this._localExtensionPath);
        });

        // Filter out this extension!
        localExtensions = localExtensions.filter(ext => {
            return !ext.extensionPath.includes('fetch-user-environment');
        });

        for (let ext in localExtensions) {
            let srcPath = localExtensions[ext].extensionPath;
            let dstPath = path.join(this._remoteExtensionPath, path.basename(srcPath));
            fse.copy(srcPath, dstPath, function (err) {
                if (err) return console.error(err);
            });
        }
    }

    private readSettingsFile(filePath: string, filter: boolean = true) {
        try {
            // Read settings file
            // Need to strip comments out...
            var settingsFile = JSON.parse(stripJsonComments(fs.readFileSync(filePath, 'UTF-8')));
        }
        catch (err) {
            // Invalid JSON data
            throw new JSONError(err.message, filePath);
        }

        if (filter) {
            // Filter out settings related to this extension
            for (let prop in settingsFile) {
                if (settingsFile.hasOwnProperty(prop) && prop.startsWith('fetchUserEnv')) {
                    delete settingsFile[prop];
                }
            }
        }

        return settingsFile;
    }

    private updateSettings(newSettings: {}) {
        var localSettings = {};
        var localSettingsFile = path.join(this._localSettingsPath, 'settings.json');

        // Does the local settings file exist yet?
        if (fs.existsSync(localSettingsFile)) {
            try {
                // It exists!  Read local settings file so new settings can be merged and saved
                // Don't filter out settings related to this extension
                localSettings = this.readSettingsFile(localSettingsFile, false);
            }
            catch (err) {
                throw err;
            }
        }

        // Update cached local settings
        Object.assign(localSettings, newSettings);

        // Save back to disk (creating the local settings file if required)
        var localSettingsJSON = JSON.stringify(localSettings, null, 2);
        fs.writeFileSync(localSettingsFile, localSettingsJSON, {encoding: 'UTF-8'});
    }

    dispose() {}
}
