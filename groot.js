
import path from 'path';
import fs from 'fs/promises';
import crypto from 'crypto';
import { diffLines } from 'diff';
import chalk from 'chalk';
import { Command } from 'commander';
import micromatch from 'micromatch';

const program = new Command();

class Groot {

    constructor(repoPath = '.') {
        this.repoPath = path.join(repoPath, '.groot');
        this.objectsPath = path.join(this.repoPath, 'objects');
        this.headPath = path.join(this.repoPath, 'HEAD');
        this.indexPath = path.join(this.repoPath, 'index');
        this.refsPath = path.join(this.repoPath, 'refs', 'heads');
        this.remotePath = path.join(this.repoPath, 'refs', 'remotes');
        this.grootIgnorePath = path.join(path.dirname(this.repoPath), '.grootignore');
        this.workingDir = path.dirname(this.repoPath);
        this.init();
    }

    async init() {
        await fs.mkdir(this.objectsPath, {recursive: true});
        await fs.mkdir(this.refsPath, {recursive: true});
        await fs.mkdir(this.remotePath, {recursive: true});

        try {
            await fs.writeFile(this.headPath, 'ref: refs/heads/main', {flag: 'wx'});
            await fs.writeFile(this.indexPath, JSON.stringify([]), {flag: 'wx'});
        } catch (error) {
            // Already initialized
        }
    }

    hashObject(content) {
        return crypto.createHash('sha1').update(content, 'utf-8').digest('hex');
    }

    async getIgnorePatterns() {
        try {
            const ignoreContent = await fs.readFile(this.grootIgnorePath, { encoding: 'utf-8' });
            return ignoreContent
                .split('\n')
                .map(line => line.trim())
                .filter(line => line && !line.startsWith('#'));
        } catch (error) {
            return [];
        }
    }

    async shouldIgnore(filePath) {
        const patterns = await this.getIgnorePatterns();
        const relativePath = path.relative(this.workingDir, filePath);
        return micromatch.isMatch(relativePath, patterns);
    }

    async add(fileToBeAdded) {
        if (await this.shouldIgnore(fileToBeAdded)) {
            console.log(chalk.yellow(`Ignored: ${fileToBeAdded}`));
            return;
        }

        try {
            const fileData = await fs.readFile(fileToBeAdded, { encoding: 'utf-8' });
            const fileHash = this.hashObject(fileData);
            const newFileHashedObjectPath = path.join(this.objectsPath, fileHash);
            await fs.writeFile(newFileHashedObjectPath, fileData);
            await this.updateStagingArea(fileToBeAdded, fileHash);
            console.log(chalk.green(`✓ Added ${fileToBeAdded}`));
        } catch (error) {
            console.log(chalk.red(`Error adding file: ${error.message}`));
        }
    }

    async updateStagingArea(filePath, fileHash) {
        const index = JSON.parse(await fs.readFile(this.indexPath, { encoding: 'utf-8' }));
        const existingIndex = index.findIndex(item => item.path === filePath);

        if (existingIndex !== -1) {
            index[existingIndex].hash = fileHash;
        } else {
            index.push({ path: filePath, hash: fileHash });
        }

        await fs.writeFile(this.indexPath, JSON.stringify(index));
    }

    async commit(message) {
        const index = JSON.parse(await fs.readFile(this.indexPath, { encoding: 'utf-8' }));

        if (index.length === 0) {
            console.log(chalk.yellow('Nothing to commit. Stage files with "groot add <file>"'));
            return;
        }

        const parentCommit = await this.getCurrentHead();
        const currentBranch = await this.getCurrentBranch();

        const commitData = {
            timeStamp: new Date().toISOString(),
            message,
            files: index,
            parent: parentCommit,
            branch: currentBranch
        };

        const commitHash = this.hashObject(JSON.stringify(commitData));
        const commitPath = path.join(this.objectsPath, commitHash);
        await fs.writeFile(commitPath, JSON.stringify(commitData));
        await this.updateBranchRef(currentBranch, commitHash);
        await fs.writeFile(this.indexPath, JSON.stringify([]));
        console.log(chalk.green(`✓ Commit created: ${commitHash.substring(0, 7)}`));
        console.log(chalk.cyan(`[${currentBranch}] ${message}`));
    }

    async getCurrentHead() {
        try {
            const headContent = await fs.readFile(this.headPath, { encoding: 'utf-8' });
            if (headContent.startsWith('ref:')) {
                const refPath = headContent.split(' ')[1].trim();
                const branchPath = path.join(this.repoPath, refPath);
                try {
                    return await fs.readFile(branchPath, { encoding: 'utf-8' });
                } catch {
                    return null;
                }
            }
            return headContent;
        } catch(error) {
            return null;
        }
    }

    async getCurrentBranch() {
        try {
            const headContent = await fs.readFile(this.headPath, { encoding: 'utf-8' });
            if (headContent.startsWith('ref:')) {
                const refPath = headContent.split(' ')[1].trim();
                return path.basename(refPath);
            }
            return 'detached HEAD';
        } catch(error) {
            return 'main';
        }
    }

    async updateBranchRef(branchName, commitHash) {
        const branchPath = path.join(this.refsPath, branchName);
        await fs.writeFile(branchPath, commitHash);
    }

    async log() {
        let currentCommitHash = await this.getCurrentHead();
        const currentBranch = await this.getCurrentBranch();

        console.log(chalk.bold(`\n📜 Commit History (${currentBranch})\n`));

        if (!currentCommitHash) {
            console.log(chalk.yellow('No commits yet.'));
            return;
        }

        while(currentCommitHash) {
            const commitData = JSON.parse(await fs.readFile(path.join(this.objectsPath, currentCommitHash), { encoding: 'utf-8' }));
            console.log(chalk.yellow(`commit ${currentCommitHash}`));
            console.log(chalk.cyan(`Date: ${new Date(commitData.timeStamp).toLocaleString()}`));
            console.log(`\n    ${commitData.message}\n`);
            currentCommitHash = commitData.parent;
        }
    }

    async showCommitDiff(commitHash) {
        const commitData = JSON.parse(await this.getCommitData(commitHash));
        if(!commitData) {
            console.log(chalk.red("Commit not found"));
            return;
        }

        console.log(chalk.bold(`\n📋 Changes in commit ${commitHash.substring(0, 7)}\n`));

        for(const file of commitData.files) {
            console.log(chalk.cyan(`File: ${file.path}`));
            const fileContent = await this.getFileContent(file.hash);

            if(commitData.parent) {
                const parentCommitData = JSON.parse(await this.getCommitData(commitData.parent));
                const getParentFileContent = await this.getParentFileContent(parentCommitData, file.path);
                if(getParentFileContent !== undefined) {
                    const diff = diffLines(getParentFileContent, fileContent);
                    diff.forEach(part => {
                        if(part.added) {
                            process.stdout.write(chalk.green("+ " + part.value));
                        } else if(part.removed) {
                            process.stdout.write(chalk.red("- " + part.value));
                        } else {
                            process.stdout.write(chalk.grey("  " + part.value));
                        }
                    });
                    console.log();
                } else {
                    console.log(chalk.green("(New file)"));
                }
            } else {
                console.log(chalk.green("(Initial commit)"));
            }
        }
    }

    async getParentFileContent(parentCommitData, filePath) {
        const parentFile = parentCommitData.files.find(file => file.path === filePath);
        if(parentFile) {
            return await this.getFileContent(parentFile.hash);
        }
    }

    async getCommitData(commithash) {
        const commitPath = path.join(this.objectsPath, commithash);
        try {
            return await fs.readFile(commitPath, { encoding: 'utf-8'});
        } catch(error) {
            return null;
        }
    }

    async getFileContent(fileHash) {
        const objectPath = path.join(this.objectsPath, fileHash);
        return fs.readFile(objectPath, { encoding: 'utf-8' });
    }

    async branch(branchName, options = {}) {
        if (!branchName) {
            await this.listBranches();
            return;
        }

        if (options.delete) {
            await this.deleteBranch(branchName);
            return;
        }

        const branchPath = path.join(this.refsPath, branchName);
        try {
            const currentCommit = await this.getCurrentHead();
            await fs.writeFile(branchPath, currentCommit || '', {flag: 'wx'});
            console.log(chalk.green(`✓ Created branch: ${branchName}`));
        } catch (error) {
            console.log(chalk.red(`Branch ${branchName} already exists`));
        }
    }

    async listBranches() {
        const branches = await fs.readdir(this.refsPath);
        const currentBranch = await this.getCurrentBranch();

        console.log(chalk.bold('\n🌳 Branches:\n'));
        for (const branch of branches) {
            if (branch === currentBranch) {
                console.log(chalk.green(`* ${branch}`));
            } else {
                console.log(`  ${branch}`);
            }
        }
        console.log();
    }

    async deleteBranch(branchName) {
        const currentBranch = await this.getCurrentBranch();
        if (currentBranch === branchName) {
            console.log(chalk.red(`Cannot delete current branch: ${branchName}`));
            return;
        }

        const branchPath = path.join(this.refsPath, branchName);
        try {
            await fs.unlink(branchPath);
            console.log(chalk.green(`✓ Deleted branch: ${branchName}`));
        } catch (error) {
            console.log(chalk.red(`Branch ${branchName} not found`));
        }
    }

    async checkout(branchName) {
        const branchPath = path.join(this.refsPath, branchName);
        try {
            const branchCommit = await fs.readFile(branchPath, { encoding: 'utf-8' });
            await fs.writeFile(this.headPath, `ref: refs/heads/${branchName}`);

            if (branchCommit) {
                await this.restoreFiles(branchCommit);
            }

            console.log(chalk.green(`✓ Switched to branch: ${branchName}`));
        } catch (error) {
            console.log(chalk.red(`Branch ${branchName} not found`));
        }
    }

    async restoreFiles(commitHash) {
        const commitData = JSON.parse(await this.getCommitData(commitHash));
        if (!commitData) return;

        for (const file of commitData.files) {
            const fileContent = await this.getFileContent(file.hash);
            const filePath = path.join(this.workingDir, file.path);
            await fs.mkdir(path.dirname(filePath), { recursive: true });
            await fs.writeFile(filePath, fileContent);
        }
    }

    async status() {
        const index = JSON.parse(await fs.readFile(this.indexPath, { encoding: 'utf-8' }));
        const currentBranch = await this.getCurrentBranch();
        const currentCommit = await this.getCurrentHead();

        console.log(chalk.bold(`\n📊 Status\n`));
        console.log(chalk.cyan(`On branch: ${currentBranch}`));

        if (!currentCommit) {
            console.log(chalk.yellow('No commits yet\n'));
        } else {
            console.log(chalk.gray(`Latest commit: ${currentCommit.substring(0, 7)}\n`));
        }

        if (index.length > 0) {
            console.log(chalk.green('Changes staged for commit:'));
            for (const file of index) {
                console.log(chalk.green(`  + ${file.path}`));
            }
            console.log();
        }

        const allFiles = await this.getAllFiles(this.workingDir);
        const untracked = [];
        const modified = [];

        for (const file of allFiles) {
            if (await this.shouldIgnore(file)) continue;

            const relativePath = path.relative(this.workingDir, file);
            if (relativePath.startsWith('.groot')) continue;

            const isStaged = index.find(item => item.path === relativePath);
            const isTracked = currentCommit ? await this.isFileTracked(relativePath, currentCommit) : false;

            if (!isStaged && !isTracked) {
                untracked.push(relativePath);
            } else if (isTracked && !isStaged) {
                const hasChanged = await this.hasFileChanged(relativePath, currentCommit);
                if (hasChanged) {
                    modified.push(relativePath);
                }
            }
        }

        if (modified.length > 0) {
            console.log(chalk.red('Changes not staged:'));
            for (const file of modified) {
                console.log(chalk.red(`  M ${file}`));
            }
            console.log();
        }

        if (untracked.length > 0) {
            console.log(chalk.gray('Untracked files:'));
            for (const file of untracked) {
                console.log(chalk.gray(`  ? ${file}`));
            }
            console.log();
        }

        if (index.length === 0 && modified.length === 0 && untracked.length === 0) {
            console.log(chalk.green('✓ Working directory clean\n'));
        }
    }

    async getAllFiles(dir, fileList = []) {
        const files = await fs.readdir(dir);
        for (const file of files) {
            const filePath = path.join(dir, file);
            const stat = await fs.stat(filePath);
            if (stat.isDirectory()) {
                if (file !== '.groot') {
                    await this.getAllFiles(filePath, fileList);
                }
            } else {
                fileList.push(filePath);
            }
        }
        return fileList;
    }

    async isFileTracked(filePath, commitHash) {
        const commitData = JSON.parse(await this.getCommitData(commitHash));
        if (!commitData) return false;
        return commitData.files.some(file => file.path === filePath);
    }

    async hasFileChanged(filePath, commitHash) {
        const commitData = JSON.parse(await this.getCommitData(commitHash));
        if (!commitData) return true;

        const trackedFile = commitData.files.find(file => file.path === filePath);
        if (!trackedFile) return true;

        try {
            const currentContent = await fs.readFile(path.join(this.workingDir, filePath), { encoding: 'utf-8' });
            const currentHash = this.hashObject(currentContent);
            return currentHash !== trackedFile.hash;
        } catch {
            return true;
        }
    }

    async graph() {
        let currentCommitHash = await this.getCurrentHead();

        console.log(chalk.bold('\n🌲 Commit Graph\n'));

        if (!currentCommitHash) {
            console.log(chalk.yellow('No commits yet.'));
            return;
        }

        const visited = new Set();
        await this.drawGraph(currentCommitHash, '', visited, true);
        console.log();
    }

    async drawGraph(commitHash, prefix, visited, isLast) {
        if (!commitHash || visited.has(commitHash)) return;
        visited.add(commitHash);

        const commitData = JSON.parse(await this.getCommitData(commitHash));
        if (!commitData) return;

        const branch = prefix + (isLast ? '└── ' : '├── ');
        const continuation = prefix + (isLast ? '    ' : '│   ');

        const shortHash = chalk.yellow(commitHash.substring(0, 7));
        const message = chalk.white(commitData.message);
        const date = chalk.gray(new Date(commitData.timeStamp).toLocaleDateString());

        console.log(`${branch}${shortHash} ${message} (${date})`);

        if (commitData.parent) {
            await this.drawGraph(commitData.parent, continuation, visited, true);
        }
    }

    async merge(branchName) {
        const currentBranch = await this.getCurrentBranch();
        if (currentBranch === branchName) {
            console.log(chalk.yellow('Already on branch: ' + branchName));
            return;
        }

        const branchPath = path.join(this.refsPath, branchName);
        try {
            const branchCommit = await fs.readFile(branchPath, { encoding: 'utf-8' });
            const currentCommit = await this.getCurrentHead();

            if (!branchCommit) {
                console.log(chalk.red('Branch has no commits'));
                return;
            }

            const branchData = JSON.parse(await this.getCommitData(branchCommit));
            const currentData = currentCommit ? JSON.parse(await this.getCommitData(currentCommit)) : { files: [] };

            const conflicts = await this.detectConflicts(currentData.files, branchData.files);

            if (conflicts.length > 0) {
                console.log(chalk.red('\n⚠️  Merge conflicts detected:\n'));
                conflicts.forEach(file => {
                    console.log(chalk.red(`  ✗ ${file}`));
                });
                console.log(chalk.yellow('\nResolve conflicts manually and commit.'));
                return;
            }

            const mergedFiles = this.mergeFiles(currentData.files, branchData.files);

            for (const file of mergedFiles) {
                await this.updateStagingArea(file.path, file.hash);
                const fileContent = await this.getFileContent(file.hash);
                await fs.writeFile(path.join(this.workingDir, file.path), fileContent);
            }

            console.log(chalk.green(`✓ Merged ${branchName} into ${currentBranch}`));
            console.log(chalk.yellow('Changes staged. Commit to complete merge.'));

        } catch (error) {
            console.log(chalk.red(`Error merging: ${error.message}`));
        }
    }

    async detectConflicts(currentFiles, branchFiles) {
        const conflicts = [];

        for (const branchFile of branchFiles) {
            const currentFile = currentFiles.find(f => f.path === branchFile.path);
            if (currentFile && currentFile.hash !== branchFile.hash) {
                conflicts.push(branchFile.path);
            }
        }

        return conflicts;
    }

    mergeFiles(currentFiles, branchFiles) {
        const merged = [...currentFiles];

        for (const branchFile of branchFiles) {
            const existingIndex = merged.findIndex(f => f.path === branchFile.path);
            if (existingIndex === -1) {
                merged.push(branchFile);
            }
        }

        return merged;
    }

    async push(remoteName = 'origin', branchName = null) {
        if (!branchName) {
            branchName = await this.getCurrentBranch();
        }

        const remoteBranchPath = path.join(this.remotePath, remoteName, branchName);
        await fs.mkdir(path.dirname(remoteBranchPath), { recursive: true });

        const currentCommit = await this.getCurrentHead();
        await fs.writeFile(remoteBranchPath, currentCommit || '');

        console.log(chalk.green(`✓ Pushed ${branchName} to ${remoteName}`));
    }

    async pull(remoteName = 'origin', branchName = null) {
        if (!branchName) {
            branchName = await this.getCurrentBranch();
        }

        const remoteBranchPath = path.join(this.remotePath, remoteName, branchName);
        try {
            const remoteCommit = await fs.readFile(remoteBranchPath, { encoding: 'utf-8' });
            const currentCommit = await this.getCurrentHead();

            if (remoteCommit === currentCommit) {
                console.log(chalk.green('Already up to date'));
                return;
            }

            await this.updateBranchRef(branchName, remoteCommit);
            await this.restoreFiles(remoteCommit);

            console.log(chalk.green(`✓ Pulled ${branchName} from ${remoteName}`));
        } catch (error) {
            console.log(chalk.red(`No remote branch: ${remoteName}/${branchName}`));
        }
    }
}

program
    .name('groot')
    .description('A lightweight Git-like version control system')
    .version('2.0.0');

program.command('init')
    .description('Initialize a new groot repository')
    .action(async () => {
        const groot = new Groot();
        console.log(chalk.green('✓ Initialized groot repository'));
    });

program.command('add <file>')
    .description('Add file to staging area')
    .action(async (file) => {
        const groot = new Groot();
        await groot.add(file);
    });

program.command('commit <message>')
    .description('Commit staged changes')
    .action(async (message) => {
        const groot = new Groot();
        await groot.commit(message);
    });

program.command('log')
    .description('Show commit history')
    .action(async () => {
        const groot = new Groot();
        await groot.log();
    });

program.command('show <commitHash>')
    .description('Show changes in a specific commit')
    .action(async (commitHash) => {
        const groot = new Groot();
        await groot.showCommitDiff(commitHash);
    });

program.command('status')
    .description('Show working tree status')
    .action(async () => {
        const groot = new Groot();
        await groot.status();
    });

program.command('branch [name]')
    .description('List, create, or delete branches')
    .option('-d, --delete', 'Delete a branch')
    .action(async (name, options) => {
        const groot = new Groot();
        await groot.branch(name, options);
    });

program.command('checkout <branch>')
    .description('Switch to a different branch')
    .action(async (branch) => {
        const groot = new Groot();
        await groot.checkout(branch);
    });

program.command('merge <branch>')
    .description('Merge a branch into current branch')
    .action(async (branch) => {
        const groot = new Groot();
        await groot.merge(branch);
    });

program.command('graph')
    .description('Show commit graph tree')
    .action(async () => {
        const groot = new Groot();
        await groot.graph();
    });

program.command('push [remote] [branch]')
    .description('Push commits to remote repository')
    .action(async (remote, branch) => {
        const groot = new Groot();
        await groot.push(remote, branch);
    });

program.command('pull [remote] [branch]')
    .description('Pull commits from remote repository')
    .action(async (remote, branch) => {
        const groot = new Groot();
        await groot.pull(remote, branch);
    });

program.parse(process.argv);
