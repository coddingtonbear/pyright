/*
 * testState.ts
 * Copyright (c) Microsoft Corporation.
 * Licensed under the MIT license.
 *
 * TestState wraps currently test states and provides a way to query and manipulate
 * the test states.
 */

import * as assert from 'assert';
import * as path from 'path';
import Char from 'typescript-char';
import { ImportResolver } from '../../../analyzer/importResolver';
import { Program } from '../../../analyzer/program';
import { ConfigOptions } from '../../../common/configOptions';
import { NullConsole } from '../../../common/console';
import { Comparison, isNumber, isString } from '../../../common/core';
import * as debug from '../../../common/debug';
import { DiagnosticCategory } from '../../../common/diagnostic';
import { combinePaths, comparePaths, getBaseFileName, normalizePath, normalizeSlashes } from '../../../common/pathUtils';
import { convertOffsetToPosition, convertPositionToOffset } from '../../../common/positionUtils';
import { getStringComparer } from '../../../common/stringUtils';
import { Position, TextRange } from '../../../common/textRange';
import * as host from '../host';
import { stringify } from '../utils';
import { createFromFileSystem } from '../vfs/factory';
import * as vfs from '../vfs/filesystem';
import { CompilerSettings, FourSlashData, FourSlashFile, GlobalMetadataOptionNames, Marker,
    MultiMap, pythonSettingFilename, Range, TestCancellationToken } from './fourSlashTypes';

export interface TextChange {
    span: TextRange;
    newText: string;
}

export class TestState {
    private readonly _cancellationToken: TestCancellationToken;
    private readonly _files: string[] = [];

    readonly fs: vfs.FileSystem;
    readonly importResolver: ImportResolver;
    readonly configOptions: ConfigOptions;
    readonly program: Program;

    // The current caret position in the active file
    currentCaretPosition = 0;
    // The position of the end of the current selection, or -1 if nothing is selected
    selectionEnd = -1;

    lastKnownMarker = '';

    // The file that's currently 'opened'
    activeFile!: FourSlashFile;

    constructor(private _basePath: string, public testData: FourSlashData) {
        const strIgnoreCase = GlobalMetadataOptionNames.ignoreCase;
        const ignoreCase = testData.globalOptions[strIgnoreCase]?.toUpperCase() === 'TRUE';

        this._cancellationToken = new TestCancellationToken();
        const configOptions = this._convertGlobalOptionsToConfigOptions(this.testData.globalOptions);

        const files: vfs.FileSet = {};
        for (const file of testData.files) {
            // if one of file is configuration file, set config options from the given json
            if (this._isConfig(file, ignoreCase)) {
                let configJson: any;
                try {
                    configJson = JSON.parse(file.content);
                } catch (e) {
                    throw new Error(`Failed to parse test ${ file.fileName }: ${ e.message }`);
                }

                configOptions.initializeFromJson(configJson, new NullConsole());
            } else {
                files[file.fileName] = new vfs.File(file.content, { meta: file.fileOptions, encoding: 'utf8' });
            }
        }

        const fs = createFromFileSystem(host.HOST, ignoreCase, { cwd: _basePath, files, meta: testData.globalOptions });

        // this should be change to AnalyzerService rather than Program
        const importResolver = new ImportResolver(fs, configOptions);
        const program = new Program(importResolver, configOptions);
        program.setTrackedFiles(Object.keys(files));

        // make sure these states are consistent between these objects.
        // later make sure we just hold onto AnalyzerService and get all these
        // state from 1 analyzerService so that we always use same consistent states
        this.fs = fs;
        this.configOptions = configOptions;
        this.importResolver = importResolver;
        this.program = program;
        this._files.push(...Object.keys(files));

        if (this._files.length > 0) {
            // Open the first file by default
            this.openFile(0);
        }
    }

    // Entry points from fourslash.ts
    goToMarker(nameOrMarker: string | Marker = '') {
        const marker = isString(nameOrMarker) ? this.getMarkerByName(nameOrMarker) : nameOrMarker;
        if (this.activeFile.fileName !== marker.fileName) {
            this.openFile(marker.fileName);
        }

        const content = this._getFileContent(marker.fileName);
        if (marker.position === -1 || marker.position > content.length) {
            throw new Error(`Marker "${ nameOrMarker }" has been invalidated by unrecoverable edits to the file.`);
        }

        const mName = isString(nameOrMarker) ? nameOrMarker : this.getMarkerName(marker);
        this.lastKnownMarker = mName;
        this.goToPosition(marker.position);
    }

    goToEachMarker(markers: readonly Marker[], action: (marker: Marker, index: number) => void) {
        debug.assert(markers.length > 0);
        for (let i = 0; i < markers.length; i++) {
            this.goToMarker(markers[i]);
            action(markers[i], i);
        }
    }

    getMarkerName(m: Marker): string {
        let found: string | undefined;
        this.testData.markerPositions.forEach((marker, name) => {
            if (marker === m) {
                found = name;
            }
        });

        debug.assertDefined(found);
        return found!;
    }

    getMarkerByName(markerName: string) {
        const markerPos = this.testData.markerPositions.get(markerName);
        if (markerPos === undefined) {
            throw new Error(`Unknown marker "${ markerName }" Available markers: ${ this.getMarkerNames().map(m => '"' + m + '"').join(', ') }`);
        } else {
            return markerPos;
        }
    }

    getMarkers(): Marker[] {
        //  Return a copy of the list
        return this.testData.markers.slice(0);
    }

    getMarkerNames(): string[] {
        return [...this.testData.markerPositions.keys()];
    }

    goToPosition(positionOrLineAndColumn: number | Position) {
        const pos = isNumber(positionOrLineAndColumn)
            ? positionOrLineAndColumn
            : this._convertPositionToOffset(this.activeFile.fileName, positionOrLineAndColumn);
        this.currentCaretPosition = pos;
        this.selectionEnd = -1;
    }

    select(startMarker: string, endMarker: string) {
        const start = this.getMarkerByName(startMarker);
        const end = this.getMarkerByName(endMarker);

        debug.assert(start.fileName === end.fileName);
        if (this.activeFile.fileName !== start.fileName) {
            this.openFile(start.fileName);
        }
        this.goToPosition(start.position);
        this.selectionEnd = end.position;
    }

    selectAllInFile(fileName: string) {
        this.openFile(fileName);
        this.goToPosition(0);
        this.selectionEnd = this.activeFile.content.length;
    }

    selectRange(range: Range): void {
        this.goToRangeStart(range);
        this.selectionEnd = range.end;
    }

    selectLine(index: number) {
        const lineStart = this._convertPositionToOffset(this.activeFile.fileName, { line: index, character: 0 });
        const lineEnd = lineStart + this._getLineContent(index).length;
        this.selectRange({ fileName: this.activeFile.fileName, pos: lineStart, end: lineEnd });
    }

    goToEachRange(action: (range: Range) => void) {
        const ranges = this.getRanges();
        debug.assert(ranges.length > 0);
        for (const range of ranges) {
            this.selectRange(range);
            action(range);
        }
    }

    goToRangeStart({ fileName, pos }: Range) {
        this.openFile(fileName);
        this.goToPosition(pos);
    }

    getRanges(): Range[] {
        return this.testData.ranges;
    }

    getRangesInFile(fileName = this.activeFile.fileName) {
        return this.getRanges().filter(r => r.fileName === fileName);
    }

    getRangesByText(): Map<string, Range[]> {
        if (this.testData.rangesByText) { return this.testData.rangesByText; }
        const result = this._createMultiMap<Range>(this.getRanges(), r => this._rangeText(r));
        this.testData.rangesByText = result;

        return result;
    }

    goToBOF() {
        this.goToPosition(0);
    }

    goToEOF() {
        const len = this._getFileContent(this.activeFile.fileName).length;
        this.goToPosition(len);
    }

    moveCaretRight(count = 1) {
        this.currentCaretPosition += count;
        this.currentCaretPosition = Math.min(this.currentCaretPosition, this._getFileContent(this.activeFile.fileName).length);
        this.selectionEnd = -1;
    }

    // Opens a file given its 0-based index or fileName
    openFile(indexOrName: number | string, content?: string): void {
        const fileToOpen: FourSlashFile = this._findFile(indexOrName);
        fileToOpen.fileName = normalizeSlashes(fileToOpen.fileName);
        this.activeFile = fileToOpen;

        // Let the host know that this file is now open
        // this.languageServiceAdapterHost.openFile(fileToOpen.fileName, content);
    }

    printCurrentFileState(showWhitespace: boolean, makeCaretVisible: boolean) {
        for (const file of this.testData.files) {
            const active = (this.activeFile === file);
            host.HOST.log(`=== Script (${ file.fileName }) ${ (active ? '(active, cursor at |)' : '') } ===`);
            let content = this._getFileContent(file.fileName);
            if (active) {
                content = content.substr(0, this.currentCaretPosition)
                    + (makeCaretVisible ? '|' : '') + content.substr(this.currentCaretPosition);
            }
            if (showWhitespace) {
                content = this._makeWhitespaceVisible(content);
            }
            host.HOST.log(content);
        }
    }

    deleteChar(count = 1) {
        const offset = this.currentCaretPosition;
        const ch = '';

        const checkCadence = (count >> 2) + 1;

        for (let i = 0; i < count; i++) {
            this._editScriptAndUpdateMarkers(this.activeFile.fileName, offset, offset + 1, ch);

            if (i % checkCadence === 0) {
                this._checkPostEditInvariants();
            }
        }

        this._checkPostEditInvariants();
    }

    replace(start: number, length: number, text: string) {
        this._editScriptAndUpdateMarkers(this.activeFile.fileName, start, start + length, text);
        this._checkPostEditInvariants();
    }

    deleteLineRange(startIndex: number, endIndexInclusive: number) {
        const startPos = this._convertPositionToOffset(this.activeFile.fileName, { line: startIndex, character: 0 });
        const endPos = this._convertPositionToOffset(this.activeFile.fileName, { line: endIndexInclusive + 1, character: 0 });
        this.replace(startPos, endPos - startPos, '');
    }

    deleteCharBehindMarker(count = 1) {
        let offset = this.currentCaretPosition;
        const ch = '';
        const checkCadence = (count >> 2) + 1;

        for (let i = 0; i < count; i++) {
            this.currentCaretPosition--;
            offset--;
            this._editScriptAndUpdateMarkers(this.activeFile.fileName, offset, offset + 1, ch);

            if (i % checkCadence === 0) {
                this._checkPostEditInvariants();
            }

            // Don't need to examine formatting because there are no formatting changes on backspace.
        }

        this._checkPostEditInvariants();
    }

    // Enters lines of text at the current caret position
    type(text: string) {
        let offset = this.currentCaretPosition;
        const selection = this._getSelection();
        this.replace(selection.start, selection.length, '');

        for (let i = 0; i < text.length; i++) {
            const ch = text.charAt(i);
            this._editScriptAndUpdateMarkers(this.activeFile.fileName, offset, offset, ch);

            this.currentCaretPosition++;
            offset++;
        }

        this._checkPostEditInvariants();
    }

    // Enters text as if the user had pasted it
    paste(text: string) {
        this._editScriptAndUpdateMarkers(this.activeFile.fileName, this.currentCaretPosition, this.currentCaretPosition, text);
        this._checkPostEditInvariants();
    }

    verifyDiagnostics(map?: { [marker: string]: { category: string; message: string } }): void {
        while (this.program.analyze()) {
            // Continue to call analyze until it completes. Since we're not
            // specifying a timeout, it should complete the first time.
        }

        const sourceFiles = this._files.map(f => this.program.getSourceFile(f));
        const results = sourceFiles.map((sourceFile, index) => {
            if (sourceFile) {
                const diagnostics = sourceFile.getDiagnostics(this.configOptions) || [];
                const filePath = sourceFile.getFilePath();
                const value = {
                    filePath,
                    parseResults: sourceFile.getParseResults(),
                    errors: diagnostics.filter(diag => diag.category === DiagnosticCategory.Error),
                    warnings: diagnostics.filter(diag => diag.category === DiagnosticCategory.Warning)
                };
                return [filePath, value] as [string, typeof value];
            } else {
                this._raiseError(`Source file not found for ${ this._files[index] }`);
            }
        });

        // organize things per file
        const resultPerFile = new Map<string, typeof results[0][1]>(results);
        const rangePerFile = this._createMultiMap<Range>(this.getRanges(), r => r.fileName);

        // expected number of files
        if (resultPerFile.size !== rangePerFile.size) {
            this._raiseError(`actual and expected doesn't match - expected: ${ stringify(rangePerFile) }, actual: ${ stringify(rangePerFile) }`);
        }

        for (const [file, ranges] of rangePerFile.entries()) {
            const rangesPerCategory = this._createMultiMap<Range>(ranges, r => {
                if (map) {
                    const name = this.getMarkerName(r.marker!);
                    return map[name].category;
                }

                return (r.marker!.data! as any).category as string;
            });

            const result = resultPerFile.get(file)!;
            for (const [category, expected] of rangesPerCategory.entries()) {
                const lines = result.parseResults!.tokenizerOutput.lines;
                const actual = category === 'error' ? result.errors : category === 'warning' ? result.warnings : this._raiseError(`unexpected category ${ category }`);

                if (expected.length !== actual.length) {
                    this._raiseError(`contains unexpected result - expected: ${ stringify(expected) }, actual: ${ actual }`);
                }

                for (const range of ranges) {
                    const rangeSpan =  TextRange.fromBounds(range.pos, range.end);
                    const matches = actual.filter(d => {
                        const diagnosticSpan = TextRange.fromBounds(convertPositionToOffset(d.range.start, lines)!,
                            convertPositionToOffset(d.range.end, lines)!);
                        return this._deepEqual(diagnosticSpan, rangeSpan); });

                    if (matches.length === 0) {
                        this._raiseError(`doesn't contain expected range: ${ stringify(range) }`);
                    }

                    // if map is provided, check messasge as well
                    if (map) {
                        const name = this.getMarkerName(range.marker!);
                        const message = map[name].message;

                        if (matches.filter(d => message === d.message).length !== 1) {
                            this._raiseError(`message doesn't match: ${ message } of ${ name } - ${ stringify(range) }, actual: ${ stringify(matches) }`);
                        }
                    }
                }
            }
        }
    }

    verifyCaretAtMarker(markerName = '') {
        const pos = this.getMarkerByName(markerName);
        if (pos.fileName !== this.activeFile.fileName) {
            throw new Error(`verifyCaretAtMarker failed - expected to be in file "${ pos.fileName }", but was in file "${ this.activeFile.fileName }"`);
        }
        if (pos.position !== this.currentCaretPosition) {
            throw new Error(`verifyCaretAtMarker failed - expected to be at marker "/*${ markerName }*/, but was at position ${ this.currentCaretPosition }(${ this._getLineColStringAtPosition(this.currentCaretPosition) })`);
        }
    }

    verifyCurrentLineContent(text: string) {
        const actual = this._getCurrentLineContent();
        if (actual !== text) {
            throw new Error('verifyCurrentLineContent\n' + this._displayExpectedAndActualString(text, actual, /* quoted */ true));
        }
    }

    verifyCurrentFileContent(text: string) {
        this._verifyFileContent(this.activeFile.fileName, text);
    }

    verifyTextAtCaretIs(text: string) {
        const actual = this._getFileContent(this.activeFile.fileName)
            .substring(this.currentCaretPosition, this.currentCaretPosition + text.length);
        if (actual !== text) {
            throw new Error('verifyTextAtCaretIs\n' + this._displayExpectedAndActualString(text, actual, /* quoted */ true));
        }
    }

    verifyRangeIs(expectedText: string, includeWhiteSpace?: boolean) {
        this._verifyTextMatches(this._rangeText(this._getOnlyRange()), !!includeWhiteSpace, expectedText);
    }

    setCancelled(numberOfCalls: number): void {
        this._cancellationToken.setCancelled(numberOfCalls);
    }

    resetCancelled(): void {
        this._cancellationToken.resetCancelled();
    }

    private _isConfig(file: FourSlashFile, ignoreCase: boolean): boolean {
        const comparer = getStringComparer(ignoreCase);
        return comparer(getBaseFileName(file.fileName), pythonSettingFilename) === Comparison.EqualTo;
    }

    private _convertGlobalOptionsToConfigOptions(globalOptions: CompilerSettings): ConfigOptions {
        const srtRoot: string = GlobalMetadataOptionNames.projectRoot;
        const projectRoot = normalizeSlashes(globalOptions[srtRoot] ?? '.');
        const configOptions = new ConfigOptions(projectRoot);

        // add more global options as we need them

        // Always enable "test mode".
        configOptions.internalTestMode = true;
        return configOptions;
    }

    private _getFileContent(fileName: string): string {
        const files = this.testData.files.filter(f => comparePaths(f.fileName, fileName, this.fs.ignoreCase) === Comparison.EqualTo);
        return files[0].content;
    }

    private _convertPositionToOffset(fileName: string, position: Position): number {
        const result = this._getParseResult(fileName);
        return convertPositionToOffset(position, result.tokenizerOutput.lines)!;
    }

    private _convertOffsetToPosition(fileName: string, offset: number): Position {
        const result = this._getParseResult(fileName);

        return convertOffsetToPosition(offset, result.tokenizerOutput.lines);
    }

    private _getParseResult(fileName: string) {
        const file = this.program.getSourceFile(fileName)!;
        file.parse(this.configOptions, this.importResolver);
        return file.getParseResults()!;
    }

    private _raiseError(message: string): never {
        throw new Error(this._messageAtLastKnownMarker(message));
    }

    private _messageAtLastKnownMarker(message: string) {
        const locationDescription = this.lastKnownMarker ? this.lastKnownMarker
            : this._getLineColStringAtPosition(this.currentCaretPosition);
        return `At ${ locationDescription }: ${ message }`;
    }

    private _checkPostEditInvariants() {
        // blank for now
    }

    private _editScriptAndUpdateMarkers(fileName: string, editStart: number, editEnd: number, newText: string) {
        // this.languageServiceAdapterHost.editScript(fileName, editStart, editEnd, newText);
        for (const marker of this.testData.markers) {
            if (marker.fileName === fileName) {
                marker.position = this._updatePosition(marker.position, editStart, editEnd, newText);
            }
        }

        for (const range of this.testData.ranges) {
            if (range.fileName === fileName) {
                range.pos = this._updatePosition(range.pos, editStart, editEnd, newText);
                range.end = this._updatePosition(range.end, editStart, editEnd, newText);
            }
        }
        this.testData.rangesByText = undefined;
    }

    private _removeWhitespace(text: string): string {
        return text.replace(/\s/g, '');
    }

    private _createMultiMap<T>(values?: T[], getKey?: (t: T) => string): MultiMap<T> {
        const map = new Map<string, T[]>() as MultiMap<T>;
        map.add = multiMapAdd;
        map.remove = multiMapRemove;

        if (values && getKey) {
            for (const value of values) {
                map.add(getKey(value), value);
            }
        }

        return map;

        function multiMapAdd<T>(this: MultiMap<T>, key: string, value: T) {
            let values = this.get(key);
            if (values) {
                values.push(value);
            } else {
                this.set(key, values = [value]);
            }
            return values;
        }

        function multiMapRemove<T>(this: MultiMap<T>, key: string, value: T) {
            const values = this.get(key);
            if (values) {
                values.forEach((v, i, arr) => { if (v === value) { arr.splice(i, 1); } });
                if (!values.length) {
                    this.delete(key);
                }
            }
        }
    }

    private _rangeText({ fileName, pos, end }: Range): string {
        return this._getFileContent(fileName).slice(pos, end);
    }

    private _getOnlyRange() {
        const ranges = this.getRanges();
        if (ranges.length !== 1) {
            this._raiseError('Exactly one range should be specified in the testfile.');
        }

        return ranges[0];
    }

    private _verifyFileContent(fileName: string, text: string) {
        const actual = this._getFileContent(fileName);
        if (actual !== text) {
            throw new Error(`verifyFileContent failed:\n${ this._showTextDiff(text, actual) }`);
        }
    }

    private _verifyTextMatches(actualText: string, includeWhitespace: boolean, expectedText: string) {
        const removeWhitespace = (s: string): string => includeWhitespace ? s : this._removeWhitespace(s);
        if (removeWhitespace(actualText) !== removeWhitespace(expectedText)) {
            this._raiseError(`Actual range text doesn't match expected text.\n${ this._showTextDiff(expectedText, actualText) }`);
        }
    }

    private _getSelection(): TextRange {
        return TextRange.fromBounds(this.currentCaretPosition, this.selectionEnd === -1 ? this.currentCaretPosition : this.selectionEnd);
    }

    private _getLineContent(index: number) {
        const text = this._getFileContent(this.activeFile.fileName);
        const pos = this._convertPositionToOffset(this.activeFile.fileName, { line: index, character: 0 });
        let startPos = pos;
        let endPos = pos;

        while (startPos > 0) {
            const ch = text.charCodeAt(startPos - 1);
            if (ch === Char.CarriageReturn || ch === Char.LineFeed) {
                break;
            }

            startPos--;
        }

        while (endPos < text.length) {
            const ch = text.charCodeAt(endPos);

            if (ch === Char.CarriageReturn || ch === Char.LineFeed) {
                break;
            }

            endPos++;
        }

        return text.substring(startPos, endPos);
    }

    // Get the text of the entire line the caret is currently at
    private _getCurrentLineContent() {
        return this._getLineContent(this._convertOffsetToPosition(
            this.activeFile.fileName,
            this.currentCaretPosition
        ).line);
    }

    private _findFile(indexOrName: string | number): FourSlashFile {
        if (typeof indexOrName === 'number') {
            const index = indexOrName;
            if (index >= this.testData.files.length) {
                throw new Error(`File index (${ index }) in openFile was out of range. There are only ${ this.testData.files.length } files in this test.`);
            } else {
                return this.testData.files[index];
            }
        } else if (isString(indexOrName)) {
            const { file, availableNames } = this._tryFindFileWorker(indexOrName);
            if (!file) {
                throw new Error(`No test file named "${ indexOrName }" exists. Available file names are: ${ availableNames.join(', ') }`);
            }
            return file;
        } else {
            return debug.assertNever(indexOrName);
        }
    }

    private _tryFindFileWorker(name: string): { readonly file: FourSlashFile | undefined; readonly availableNames: readonly string[] } {
        name = normalizePath(name);

        // names are stored in the compiler with this relative path, this allows people to use goTo.file on just the fileName
        name = name.indexOf(path.sep) === -1 ? combinePaths(this._basePath, name) : name;

        let file: FourSlashFile | undefined;
        const availableNames: string[] = [];
        this.testData.files.forEach(f => {
            const fn = normalizePath(f.fileName);
            if (fn) {
                if (fn === name) {
                    file = f;
                }

                availableNames.push(fn);
            }
        });

        debug.assertDefined(file);
        return { file, availableNames };
    }

    private _getLineColStringAtPosition(position: number, file: FourSlashFile = this.activeFile) {
        const pos = this._convertOffsetToPosition(file.fileName, position);
        return `line ${ (pos.line + 1) }, col ${ pos.character }`;
    }

    private _showTextDiff(expected: string, actual: string): string {
        // Only show whitespace if the difference is whitespace-only.
        if (this._differOnlyByWhitespace(expected, actual)) {
            expected = this._makeWhitespaceVisible(expected);
            actual = this._makeWhitespaceVisible(actual);
        }
        return this._displayExpectedAndActualString(expected, actual);
    }

    private _differOnlyByWhitespace(a: string, b: string) {
        return this._removeWhitespace(a) === this._removeWhitespace(b);
    }

    private _displayExpectedAndActualString(expected: string, actual: string, quoted = false) {
        const expectMsg = '\x1b[1mExpected\x1b[0m\x1b[31m';
        const actualMsg = '\x1b[1mActual\x1b[0m\x1b[31m';
        const expectedString = quoted ? '"' + expected + '"' : expected;
        const actualString = quoted ? '"' + actual + '"' : actual;
        return `\n${ expectMsg }:\n${ expectedString }\n\n${ actualMsg }:\n${ actualString }`;
    }

    private _makeWhitespaceVisible(text: string) {
        return text.replace(/ /g, '\u00B7').replace(/\r/g, '\u00B6').replace(/\n/g, '\u2193\n').replace(/\t/g, '\u2192   ');
    }

    private _updatePosition(position: number, editStart: number, editEnd: number, { length }: string): number {
        // If inside the edit, return -1 to mark as invalid
        return position <= editStart ? position : position < editEnd ? -1 : position + length - + (editEnd - editStart);
    }

    private _deepEqual(a: any, e: any) {
        try {
            // NOTE: find better way.
            assert.deepStrictEqual(a, e);
        } catch {
            return false;
        }

        return true;
    }
}