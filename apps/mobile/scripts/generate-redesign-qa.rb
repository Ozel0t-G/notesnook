#!/usr/bin/env ruby
# frozen_string_literal: true

# generate-redesign-qa.rb
#
# Fail-closed generator for an ISOLATED, groupless Mac Catalyst QA
# configuration of VeyraN ("VeyraN redesign QA"). It never edits the shipped
# project, plists, entitlements, constants, schemes or build configs: it loads
# the CURRENT on-disk `Notesnook.xcodeproj` through Xcodeproj and writes a
# sibling, task-owned QA project/workspace plus a `.veyran-redesignqa/` folder
# of QA-only overlays.
#
# Everything it writes lives under apps/mobile/ios and is meant to be ignored
# via the LOCAL `.git/info/exclude` (the coordinator appends the entries
# before running this script; this script never touches Git metadata).
#
# Usage (coordinator):
#   GEM_PATH=... ruby apps/mobile/scripts/generate-redesign-qa.rb
#
# Runtime needs only the xcodeproj gem + Ruby stdlib (no gem/pod install, no
# build, no launch, no signing).
#
# SIGNING MODE (see artifacts/apple-redesign-overnight/MAC_QA_SIGNING_CORRECTION.md):
#   * Every QA target uses CODE_SIGN_STYLE=Automatic with the existing team +
#     Apple Development certificate; the local `Mac Catalyst Team Provisioning
#     Profile: *` is Xcode-managed, so NO manual PROVISIONING_PROFILE /
#     PROVISIONING_PROFILE_SPECIFIER keys are written (all conditionals are
#     stripped through SIGNING_KEY_PATTERN). The expected profile UUID in the
#     receipt is a VERIFICATION EXPECTATION the coordinator checks, never a
#     forced, incompatible build setting. No signing/profile is set globally,
#     and Pods are never touched.
#   * Supported QA run is the RELEASE embedded bundle only. A QA Debug build
#     uses the RN dev server and is UNVERIFIED / unsupported unless it is
#     separately configured with the generated QA Metro overlay. This script
#     never modifies the original native JS bundle URL / dev-server config.
#
# Security posture (see artifacts/apple-redesign-overnight/MAC_QA_GENERATOR_TASK.md):
#   * QA host/share/widget bundle ids are new and disjoint from production.
#   * Every generated entitlement has ZERO App Groups and exactly ONE Keychain
#     access group: QXCNJY73A8.com.ozel0t.veyran.redesignqa20261012.
#   * QA Info plists drop appGroupId / ReactNativeQuickSQLite_AppGroup and all
#     URL + document/UTI association keys, so QA cannot register production
#     nn / veyran / ShareMedia handlers.
#   * BUNDLE_CONFIG (Metro overlay) is set on the QA host + share targets only;
#     the overlay delegates to the original resolver and substitutes only the
#     canonical app/utils/constants.ts, whose generated copy fails closed for
#     any bundle id outside the QA allowlist.
#   * Any assertion failure aborts generation without finishing.

require "digest"
require "fileutils"
require "json"
require "time"
require "xcodeproj"

# Raised for every fail-closed refusal or assertion error. The script exits
# non-zero and changes nothing outside the task-owned outputs.
class GenerationError < StandardError; end

# ---------------------------------------------------------------------------
# Fixed QA identity. These are the only QA values baked into generated files.
# ---------------------------------------------------------------------------
QA_TEAM_ID = "QXCNJY73A8"
QA_BUNDLE_PREFIX = "com.ozel0t.veyran.redesignqa20261012"
QA_HOST_BUNDLE_ID = QA_BUNDLE_PREFIX
QA_SHARE_BUNDLE_ID = "#{QA_BUNDLE_PREFIX}.share"
QA_WIDGET_BUNDLE_ID = "#{QA_BUNDLE_PREFIX}.widget"
QA_KEYCHAIN_GROUP = "#{QA_TEAM_ID}.#{QA_BUNDLE_PREFIX}"
QA_CERT_FINGERPRINT = "58A4018F522DC35ABA84C6632EBE4EF282045584"
QA_PROFILE_UUID = "56abc356-284f-40a8-b7de-33cf28125a98"
QA_PROFILE_NAME = "Mac Catalyst Team Provisioning Profile: *"
PRODUCTION_APP_GROUP = "group.com.ozel0t.note.notesnookpencil"
PRODUCTION_BUNDLE_IDS = [
  "com.ozel0t.note.notesnookpencil",
  "com.ozel0t.note.notesnookpencil.widget",
  "com.ozel0t.note.notesnookpencil.share"
].freeze

QA_DISPLAY_NAME_HOST = "VeyraN QA"
QA_DISPLAY_NAME_SHARE = "VeyraN QA Share"
QA_DISPLAY_NAME_WIDGET = "VeyraN QA Widget"

# ---------------------------------------------------------------------------
# Paths. All derived from the script location so the generator can be exercised
# on a copied tree without ever touching an unrelated checkout.
# ---------------------------------------------------------------------------
SCRIPT_DIR = File.expand_path(__dir__)
APP_DIR = File.expand_path("..", SCRIPT_DIR)               # apps/mobile
IOS_DIR = File.expand_path("ios", APP_DIR)                # apps/mobile/ios

ORIGINAL_PROJECT = File.join(IOS_DIR, "Notesnook.xcodeproj")
ORIGINAL_SCHEMES_DIR = File.join(ORIGINAL_PROJECT, "xcshareddata", "xcschemes")
ORIGINAL_WORKSPACE = File.join(IOS_DIR, "Notesnook.xcworkspace")
ORIGINAL_METRO_CONFIG = File.join(APP_DIR, "metro.config.js")
ORIGINAL_CONSTANTS = File.join(APP_DIR, "app", "utils", "constants.ts")

# Optional active build xcconfig. When present it influences the shipped build,
# so its hash is captured, receipted and re-verified like every other source.
ORIGINAL_ACTIVE_XCCONFIG = File.join(IOS_DIR, "build-configs", "ios-build.active.xcconfig")

QA_PROJECT = File.join(IOS_DIR, "VeyraNRedesignQA.xcodeproj")
QA_WORKSPACE = File.join(IOS_DIR, "VeyraNRedesignQA.xcworkspace")
QA_DIR = File.join(IOS_DIR, ".veyran-redesignqa")
QA_ENTITLEMENTS_DIR = File.join(QA_DIR, "entitlements")
QA_PLISTS_DIR = File.join(QA_DIR, "Info-plists")
QA_METRO_CONFIG = File.join(QA_DIR, "metro.config.cjs")
QA_CONSTANTS = File.join(QA_DIR, "constants.qa.ts")
QA_RECEIPT = File.join(QA_DIR, "source-hash-receipt.json")
QA_SCHEMES_DIR = File.join(QA_PROJECT, "xcshareddata", "xcschemes")

# Ownership marker. An existing output directory is only overwritten when it
# carries exactly this file/body, so the generator can never clobber an
# unrelated directory that merely happens to share a name.
OWNER_MARKER_FILE = ".veyran-redesign-qa-generated"
OWNER_MARKER_BODY = <<~'TXT'
  Owned by apps/mobile/scripts/generate-redesign-qa.rb (VeyraN redesign QA).
  Regenerate with that script instead of editing anything here by hand.
  Including this marker means the directory is safe for the generator to replace.
TXT

SCHEME_FILES = ["Notesnook.xcscheme", "NotesnookRelease.xcscheme", "Make Note.xcscheme"].freeze
ORIGINAL_PROJECT_CONTAINER = "container:Notesnook.xcodeproj"
QA_PROJECT_CONTAINER = "container:VeyraNRedesignQA.xcodeproj"
PODS_CONTAINER = "container:Pods/Pods.xcodeproj"

# Same shape as the shipped Notesnook.xcworkspace, only the first project is
# swapped for the generated sibling. Pods stays a relative reference.
QA_WORKSPACE_CONTENTS = <<~'XML'
  <?xml version="1.0" encoding="UTF-8"?>
  <Workspace
     version = "1.0">
     <FileRef
        location = "group:VeyraNRedesignQA.xcodeproj">
     </FileRef>
     <FileRef
        location = "group:Pods/Pods.xcodeproj">
     </FileRef>
  </Workspace>
XML

# Build-setting keys that select signing. Anything matching one of these on a
# QA target configuration that we do not explicitly (re)write is a stale
# production conditional and gets removed from the generated project.
SIGNING_KEY_PATTERN = /\A(CODE_SIGN_IDENTITY|CODE_SIGN_STYLE|CODE_SIGN_ENTITLEMENTS|DEVELOPMENT_TEAM|PROVISIONING_PROFILE|PROVISIONING_PROFILE_SPECIFIER)(\[[^\]]+\])?\z/

# Exact source anchors inside app/utils/constants.ts. Generated from the
# CURRENT dirty file; asserted to occur exactly once before substitution.
CONSTANTS_IMPORT_ANCHOR = 'import { getVersion, isEmulatorSync } from "react-native-device-info";'
CONSTANTS_IMPORT_REPLACEMENT =
  'import { getVersion, isEmulatorSync, getBundleId } from "react-native-device-info";'
CONSTANTS_KEYCHAIN_FUNCTION_ANCHOR = <<~'TS'.chomp
  export function getKeychainAccessGroup(): string {
    return isMacCatalyst() ? `${APPLE_TEAM_ID}.${IOS_APPGROUPID}` : IOS_APPGROUPID;
  }
TS

CONSTANTS_KEYCHAIN_FUNCTION_REPLACEMENT = <<~'TS'.chomp
  const QA_KEYCHAIN_ACCESS_GROUP =
    "__QA_KEYCHAIN_GROUP__";

  /**
   * Redesign QA is signed into the sole keychain access group above on an
   * isolated bundle id. Only the QA host and QA share bundles may use it;
   * anything else fails closed instead of falling back to a production group.
   */
  const QA_KEYCHAIN_ALLOWED_BUNDLE_IDS = [
    "__QA_HOST_BUNDLE_ID__",
    "__QA_SHARE_BUNDLE_ID__"
  ];

  if (!QA_KEYCHAIN_ACCESS_GROUP.startsWith(`${APPLE_TEAM_ID}.`)) {
    throw new Error("VeyraN redesign QA: keychain group must be team-prefixed");
  }

  export function getKeychainAccessGroup(): string {
    const bundleId = getBundleId();
    if (QA_KEYCHAIN_ALLOWED_BUNDLE_IDS.indexOf(bundleId) === -1) {
      throw new Error(
        `VeyraN redesign QA: refusing keychain access for unexpected bundle id "${bundleId}"`
      );
    }
    return QA_KEYCHAIN_ACCESS_GROUP;
  }
TS

METRO_OVERLAY = <<~'JS'
  /**
   * VeyraN redesign QA Metro overlay (generated; do not edit by hand).
   *
   * Loads the CURRENT production metro.config.js unchanged, preserves its
   * resolver behaviour and every unrelated module, and substitutes ONLY the
   * resolved canonical app/utils/constants.ts source file with the generated
   * QA copy. It compares fs.realpathSync of the canonical original against the
   * resolved source: a resolution that identifies an alternative
   * app/utils/constants.ts (e.g. a symlinked or aliased copy) fails closed
   * instead of silently falling back to production constants. The original
   * file is never modified and no basename-only replacement of unrelated
   * third-party `constants.ts` files is performed.
   *
   * SUPPORTED RUN: Release embedded bundle only. A Debug build uses the RN dev
   * server and is UNVERIFIED / unsupported unless it is separately configured
   * with this QA Metro overlay; the native JS bundle URL is left untouched.
   */
  const fs = require("fs");
  const path = require("path");

  const original = require("../../metro.config.js");

  const APP_ROOT = path.resolve(__dirname, "..", "..");
  const CANONICAL_CONSTANTS = path.resolve(
    APP_ROOT,
    "app",
    "utils",
    "constants.ts"
  );
  const QA_CONSTANTS = path.resolve(__dirname, "constants.qa.ts");
  const CONSTANTS_SUFFIX = path.join("app", "utils", "constants.ts");

  // Fail clearly when the canonical original constants file is inaccessible so
  // the overlay can never silently substitute nothing (production fallback).
  let canonicalConstantsReal;
  try {
    canonicalConstantsReal = fs.realpathSync(CANONICAL_CONSTANTS);
  } catch (error) {
    throw new Error(
      "VeyraN redesign QA: canonical constants are inaccessible (" +
        CANONICAL_CONSTANTS +
        "): " +
        error.message
    );
  }

  if (!original || typeof original !== "object" || !original.resolver) {
    throw new Error(
      "VeyraN redesign QA: original metro.config.js has no resolver"
    );
  }
  const delegateResolveRequest = original.resolver.resolveRequest;
  if (typeof delegateResolveRequest !== "function") {
    throw new Error(
      "VeyraN redesign QA: original metro.config.js has no resolver.resolveRequest"
    );
  }

  function substituteConstants(resolution) {
    if (
      !resolution ||
      resolution.type !== "sourceFile" ||
      typeof resolution.filePath !== "string"
    ) {
      return resolution;
    }
    const resolvedPath = path.resolve(resolution.filePath);
    if (
      resolvedPath !== CANONICAL_CONSTANTS &&
      !resolvedPath.endsWith(path.sep + CONSTANTS_SUFFIX)
    ) {
      return resolution;
    }

    let resolvedReal;
    try {
      resolvedReal = fs.realpathSync(resolvedPath);
    } catch (error) {
      throw new Error(
        "VeyraN redesign QA: cannot inspect resolved constants candidate (" +
          resolution.filePath +
          "): " +
          error.message
      );
    }
    if (resolvedReal !== canonicalConstantsReal) {
      throw new Error(
        "VeyraN redesign QA: resolver returned an alternative " +
          "app/utils/constants.ts (" +
          resolvedReal +
          ") that is not the canonical " +
          canonicalConstantsReal +
          "; refusing to fall back to production constants."
      );
    }
    return Object.assign({}, resolution, { filePath: QA_CONSTANTS });
  }

  const config = Object.assign({}, original);
  config.resolver = Object.assign({}, original.resolver, {
    resolveRequest: function (context, moduleName, platform) {
      const result = delegateResolveRequest(context, moduleName, platform);
      if (result && typeof result.then === "function") {
        return result.then(substituteConstants);
      }
      return substituteConstants(result);
    }
  });

  module.exports = config;
JS

# ---------------------------------------------------------------------------
# Target definitions. `key` -> host/share/widget.
# ---------------------------------------------------------------------------
TARGET_SPECS = [
  {
    key: :host,
    target_name: "Notesnook",
    bundle_id: QA_HOST_BUNDLE_ID,
    bundle_var: "IOS_MAIN_BUNDLE_ID",
    display_name: QA_DISPLAY_NAME_HOST,
    info_source: "Notesnook/Info.plist",
    info_output: "host-Info.plist",
    entitlements_ios: "host.entitlements",
    entitlements_macos: "host-macosx.entitlements",
    metro_overlay: true,
    app_display_name: QA_DISPLAY_NAME_HOST,
    strip_document_handlers: true
  },
  {
    key: :share,
    target_name: "Make Note",
    bundle_id: QA_SHARE_BUNDLE_ID,
    bundle_var: "IOS_SHARE_BUNDLE_ID",
    display_name: QA_DISPLAY_NAME_SHARE,
    info_source: "Make Note/Info.plist",
    info_output: "share-Info.plist",
    entitlements_ios: "share.entitlements",
    entitlements_macos: "share-macosx.entitlements",
    metro_overlay: true,
    app_display_name: nil,
    strip_document_handlers: false
  },
  {
    key: :widget,
    target_name: "NotesWidgetExtension",
    bundle_id: QA_WIDGET_BUNDLE_ID,
    bundle_var: "IOS_WIDGET_BUNDLE_ID",
    display_name: QA_DISPLAY_NAME_WIDGET,
    info_source: "NotesWidget/Info.plist",
    info_output: "widget-Info.plist",
    entitlements_ios: "widget.entitlements",
    entitlements_macos: "widget-macosx.entitlements",
    metro_overlay: false,
    app_display_name: nil,
    strip_document_handlers: false
  }
].freeze

# Info.plist keys that must never appear in a QA plist.
#  * shared-container roots: make MMKV/quick-sqlite pick a group container.
#  * URL/document/UTI association: would re-register production nn / veyran /
#    ShareMedia handlers and the nnbackup document type.
SHARED_CONTAINER_PLIST_KEYS = %w[appGroupId ReactNativeQuickSQLite_AppGroup].freeze
DOCUMENT_ASSOCIATION_PLIST_KEYS = %w[
  CFBundleURLTypes
  CFBundleDocumentTypes
  UTExportedTypeDeclarations
  LSSupportsOpeningDocumentsInPlace
  UISupportsDocumentBrowser
].freeze
FORBIDDEN_PLIST_KEYS = (SHARED_CONTAINER_PLIST_KEYS + DOCUMENT_ASSOCIATION_PLIST_KEYS).freeze

# The complete set of QA build-setting keys we write on each target config.
#
# Signing is AUTOMATIC against the existing team/certificate because the local
# `Mac Catalyst Team Provisioning Profile: *` is Xcode-managed. No manual
# PROVISIONING_PROFILE / PROVISIONING_PROFILE_SPECIFIER keys (or conditionals)
# are written: SIGNING_KEY_PATTERN strips any inherited ones, so Xcode resolves
# the profile itself and the coordinator builds without
# -allowProvisioningUpdates. The expected profile UUID lives only in the
# receipt, to be verified against the actual signed artifacts.
def qa_signing_keys(spec)
  keys = {
    "CODE_SIGN_STYLE" => "Automatic",
    "CODE_SIGN_IDENTITY" => "Apple Development",
    "CODE_SIGN_IDENTITY[sdk=iphoneos*]" => "Apple Development",
    "CODE_SIGN_IDENTITY[sdk=macosx*]" => "Apple Development",
    "DEVELOPMENT_TEAM" => QA_TEAM_ID,
    "DEVELOPMENT_TEAM[sdk=iphoneos*]" => QA_TEAM_ID,
    "DEVELOPMENT_TEAM[sdk=macosx*]" => QA_TEAM_ID,
    "CODE_SIGN_ENTITLEMENTS" => ".veyran-redesignqa/entitlements/#{spec[:entitlements_ios]}",
    "CODE_SIGN_ENTITLEMENTS[sdk=macosx*]" => ".veyran-redesignqa/entitlements/#{spec[:entitlements_macos]}",
    "INFOPLIST_FILE" => ".veyran-redesignqa/Info-plists/#{spec[:info_output]}",
    "INFOPLIST_FILE[sdk=macosx*]" => ".veyran-redesignqa/Info-plists/#{spec[:info_output]}",
    "PRODUCT_BUNDLE_IDENTIFIER" => spec[:bundle_id],
    "IOS_MAIN_BUNDLE_ID" => QA_HOST_BUNDLE_ID,
    "IOS_SHARE_BUNDLE_ID" => QA_SHARE_BUNDLE_ID,
    "IOS_WIDGET_BUNDLE_ID" => QA_WIDGET_BUNDLE_ID,
    "DERIVE_MACCATALYST_PRODUCT_BUNDLE_IDENTIFIER" => "NO"
  }
  if spec[:metro_overlay]
    keys["BUNDLE_CONFIG"] = "$(SRCROOT)/.veyran-redesignqa/metro.config.cjs"
    keys["BUNDLE_CONFIG[sdk=macosx*]"] = "$(SRCROOT)/.veyran-redesignqa/metro.config.cjs"
    keys["BUNDLE_CONFIG[sdk=iphoneos*]"] = "$(SRCROOT)/.veyran-redesignqa/metro.config.cjs"
  end
  keys["APP_DISPLAY_NAME"] = spec[:app_display_name] if spec[:app_display_name]
  keys
end

# Entitlement contents. Every set has zero App Groups and exactly one keychain
# access group. Only permissions the local wildcard Catalyst profile grants are
# kept; time-sensitive notifications are intentionally omitted.
def entitlement_contents(spec)
  base = {
    "keychain-access-groups" => [QA_KEYCHAIN_GROUP]
  }
  case spec[:key]
  when :host
    ios = base
    macos = {
      "com.apple.security.app-sandbox" => true,
      "com.apple.security.files.user-selected.read-write" => true,
      "com.apple.security.network.client" => true,
      "com.apple.security.network.server" => true,
      "com.apple.security.personal-information.photos-library" => true,
      "com.apple.security.print" => true
    }.merge(base)
  when :share
    ios = base
    macos = {
      "com.apple.security.app-sandbox" => true,
      "com.apple.security.files.user-selected.read-only" => true,
      "com.apple.security.network.client" => true
    }.merge(base)
  when :widget
    ios = base
    macos = {
      "com.apple.security.app-sandbox" => true
    }.merge(base)
  else
    raise "unknown target spec #{spec.inspect}"
  end
  { ios: ios, macos: macos }
end

# ---------------------------------------------------------------------------
class Generator
  def initialize
    @source_hashes = {}
    @output_hashes = {}
  end

  def run
    preflight!
    capture_source_hashes!
    project = load_original_project!
    # Each prepare step marks ownership immediately, so an aborted run still
    # leaves regenerable, task-owned directories.
    prepare_output_dir!(QA_DIR)
    prepare_output_dir!(QA_PROJECT)
    prepare_output_dir!(QA_WORKSPACE)

    apply_qa_settings!(project)
    write_qa_dir!
    project.save(QA_PROJECT)
    write_schemes!
    write_workspace!

    verify!
    assert_sources_unchanged!
    write_receipt!

    puts "generate-redesign-qa: OK"
    puts "  #{rel(QA_PROJECT)}"
    puts "  #{rel(QA_WORKSPACE)}"
    puts "  #{rel(QA_DIR)}"
    puts "No production file, plist, entitlement, constant or scheme was modified."
  rescue GenerationError => e
    warn "generate-redesign-qa: FAILED: #{e.message}"
    warn "Nothing outside the task-owned outputs was changed."
    exit 1
  end

  private

  def fail!(message)
    raise GenerationError, message
  end

  def rel(path)
    path.sub("#{IOS_DIR}/", "")
  end

  # -------------------------------------------------------------------------
  # Preflight / path safety
  # -------------------------------------------------------------------------
  def preflight!
    fail!("#{IOS_DIR} is not a directory") unless File.directory?(IOS_DIR)
    assert_no_symlinks!(IOS_DIR)
    fail!("missing #{rel(ORIGINAL_PROJECT)}/project.pbxproj") unless File.file?(File.join(ORIGINAL_PROJECT, "project.pbxproj"))
    fail!("missing #{rel(ORIGINAL_WORKSPACE)}/contents.xcworkspacedata") unless File.file?(File.join(ORIGINAL_WORKSPACE, "contents.xcworkspacedata"))
    fail!("missing #{ORIGINAL_METRO_CONFIG}") unless File.file?(ORIGINAL_METRO_CONFIG)
    fail!("missing #{ORIGINAL_CONSTANTS}") unless File.file?(ORIGINAL_CONSTANTS)
    SCHEME_FILES.each do |scheme|
      path = File.join(ORIGINAL_SCHEMES_DIR, scheme)
      fail!("missing original scheme #{scheme}") unless File.file?(path)
    end
  end

  def assert_inside_root!(path)
    root_prefix = File.join(File.expand_path(IOS_DIR), "")
    expanded = File.expand_path(path)
    fail!("refusing to write outside #{IOS_DIR}: #{expanded}") unless expanded.start_with?(root_prefix)
  end

  def assert_no_symlinks!(path)
    expanded = File.expand_path(path)
    current = File::SEPARATOR
    expanded.split(File::SEPARATOR).each do |part|
      next if part.empty?

      current = File.join(current, part)
      fail!("refusing to write through symlink #{current}") if File.symlink?(current)
    end
  end

  # Creates an output directory, replacing an existing one only if it carries
  # this generator's ownership marker. Refuses symlinks and out-of-root paths.
  def prepare_output_dir!(path)
    assert_inside_root!(path)
    assert_no_symlinks!(path)
    if File.exist?(path)
      fail!("#{rel(path)} exists and is not a directory") unless File.directory?(path)

      marker = File.join(path, OWNER_MARKER_FILE)
      owned = File.file?(marker) && File.read(marker) == OWNER_MARKER_BODY
      fail!("refusing to replace #{rel(path)}: missing or changed ownership marker #{OWNER_MARKER_FILE}") unless owned

      FileUtils.rm_rf(path)
    end
    FileUtils.mkdir_p(path)
    # Mark ownership immediately: if a later step aborts, the directory is
    # still recognised as task-owned and can simply be regenerated.
    File.write(File.join(path, OWNER_MARKER_FILE), OWNER_MARKER_BODY)
  end

  # -------------------------------------------------------------------------
  # Source capture (never HEAD; always the live dirty tree)
  # -------------------------------------------------------------------------
  # Absolute path -> receipt key for every source input whose hash is captured,
  # receipted and re-verified unchanged after generation.
  def source_files
    files = {
      File.join(ORIGINAL_PROJECT, "project.pbxproj") => "ios/Notesnook.xcodeproj/project.pbxproj",
      File.join(ORIGINAL_WORKSPACE, "contents.xcworkspacedata") => "ios/Notesnook.xcworkspace/contents.xcworkspacedata",
      ORIGINAL_METRO_CONFIG => "metro.config.js",
      ORIGINAL_CONSTANTS => "app/utils/constants.ts"
    }
    SCHEME_FILES.each do |scheme|
      files[File.join(ORIGINAL_SCHEMES_DIR, scheme)] =
        "ios/Notesnook.xcodeproj/xcshareddata/xcschemes/#{scheme}"
    end
    TARGET_SPECS.each do |spec|
      files[File.join(IOS_DIR, spec[:info_source])] = "ios/#{spec[:info_source]}"
    end
    # Optional: only present/known while the active build xcconfig exists.
    if File.file?(ORIGINAL_ACTIVE_XCCONFIG)
      files[ORIGINAL_ACTIVE_XCCONFIG] = "ios/build-configs/ios-build.active.xcconfig"
    end
    files
  end

  def capture_source_hashes!
    @source_files = source_files
    @source_hashes = {}
    @source_files.each do |path, key|
      fail!("missing production source #{path}") unless File.file?(path)
      @source_hashes[key] = hash_file(path)
    end
  end

  def hash_file(path)
    Digest::SHA256.file(path).hexdigest
  end

  def assert_sources_unchanged!
    @source_files.each do |path, key|
      digest = @source_hashes.fetch(key)
      unless File.file?(path)
        fail!("production source disappeared during generation: #{path}")
      end
      fail!("production source changed during generation: #{path}") unless hash_file(path) == digest
    end
  end

  # -------------------------------------------------------------------------
  # Project
  # -------------------------------------------------------------------------
  def load_original_project!
    project = Xcodeproj::Project.open(ORIGINAL_PROJECT)
    fail!("project root is not empty") unless project.root_object.project_dir_path.to_s.empty?
    fail!("project root dir is not empty") unless project.root_object.project_root.to_s.empty?
    TARGET_SPECS.each do |spec|
      fail!("missing target #{spec[:target_name]}") unless project.targets.any? { |t| t.name == spec[:target_name] }
    end
    project
  end

  def apply_qa_settings!(project)
    # Strip conflicting inherited signing conditionals at project level so no
    # production identity can be inherited by the QA targets.
    project.build_configurations.each do |config|
      config.build_settings.keys.each do |key|
        config.build_settings.delete(key) if key =~ SIGNING_KEY_PATTERN
      end
    end

    TARGET_SPECS.each do |spec|
      target = project.targets.find { |t| t.name == spec[:target_name] }
      allowed = qa_signing_keys(spec)
      target.build_configurations.each do |config|
        # Remove any stale signing conditional the QA project must not inherit.
        config.build_settings.keys.each do |key|
          next unless key =~ SIGNING_KEY_PATTERN
          next if allowed.key?(key)

          config.build_settings.delete(key)
        end
        allowed.each { |key, value| config.build_settings[key] = value }
      end
    end
  end

  # -------------------------------------------------------------------------
  # QA overlay folder
  # -------------------------------------------------------------------------
  def write_qa_dir!
    FileUtils.mkdir_p(QA_ENTITLEMENTS_DIR)
    FileUtils.mkdir_p(QA_PLISTS_DIR)

    TARGET_SPECS.each do |spec|
      contents = entitlement_contents(spec)
      write_plist!(contents[:ios], File.join(QA_ENTITLEMENTS_DIR, spec[:entitlements_ios]))
      write_plist!(contents[:macos], File.join(QA_ENTITLEMENTS_DIR, spec[:entitlements_macos]))
      write_plist!(qa_info_plist(spec), File.join(QA_PLISTS_DIR, spec[:info_output]))
    end

    write_file!(QA_METRO_CONFIG, METRO_OVERLAY)
    write_file!(QA_CONSTANTS, qa_constants_source)
  end

  def write_plist!(hash, path)
    assert_inside_root!(path)
    assert_no_symlinks!(path)
    Xcodeproj::Plist.write_to_path(hash, path)
    @output_hashes[rel(path)] = hash_file(path)
  end

  def write_file!(path, contents)
    assert_inside_root!(path)
    assert_no_symlinks!(path)
    File.write(path, contents)
    @output_hashes[rel(path)] = hash_file(path)
  end

  def qa_info_plist(spec)
    source_path = File.join(IOS_DIR, spec[:info_source])
    fail!("missing Info.plist #{spec[:info_source]}") unless File.file?(source_path)

    plist = Xcodeproj::Plist.read_from_path(source_path)
    fail!("#{spec[:info_source]} did not parse as a dictionary") unless plist.is_a?(Hash)

    # Always drop the shared-container keys; drop the URL/document/UTI
    # association keys on the app target that registers them.
    SHARED_CONTAINER_PLIST_KEYS.each { |key| plist.delete(key) }
    DOCUMENT_ASSOCIATION_PLIST_KEYS.each { |key| plist.delete(key) } if spec[:strip_document_handlers]

    plist["CFBundleDisplayName"] = spec[:display_name]
    plist
  end

  def qa_constants_source
    contents = File.read(ORIGINAL_CONSTANTS)

    if contents =~ /from\s+["']\.{1,2}\//
      fail!("app/utils/constants.ts contains relative imports; the QA copy location would break them")
    end
    name_count = contents.scan("function getKeychainAccessGroup(").length
    fail!("app/utils/constants.ts defines getKeychainAccessGroup #{name_count} times; refusing ambiguous source") unless name_count == 1

    replacement = CONSTANTS_KEYCHAIN_FUNCTION_REPLACEMENT
                  .gsub("__QA_KEYCHAIN_GROUP__", QA_KEYCHAIN_GROUP)
                  .gsub("__QA_HOST_BUNDLE_ID__", QA_HOST_BUNDLE_ID)
                  .gsub("__QA_SHARE_BUNDLE_ID__", QA_SHARE_BUNDLE_ID)

    contents = replace_exactly_once!(
      contents, CONSTANTS_IMPORT_ANCHOR, CONSTANTS_IMPORT_REPLACEMENT,
      "react-native-device-info import"
    )
    contents = replace_exactly_once!(
      contents, CONSTANTS_KEYCHAIN_FUNCTION_ANCHOR, replacement,
      "getKeychainAccessGroup()"
    )

    # The generated copy must contain the QA helper verbatim and none of the
    # production access-group return path. IOS_APPGROUPID itself stays (it is
    # unused on Catalyst because hasAppGroupContainer() is false); getKeychainAccessGroup
    # must never return it.
    fail!("QA constants copy lost the QA keychain group literal") unless contents.include?(QA_KEYCHAIN_GROUP)
    fail!("QA constants copy still returns the production App Group") if contents.include?(CONSTANTS_KEYCHAIN_FUNCTION_ANCHOR)

    contents
  end

  def replace_exactly_once!(text, anchor, replacement, what)
    count = text.scan(anchor).length
    fail!("#{what}: expected exactly one occurrence in app/utils/constants.ts, found #{count}") unless count == 1

    text.sub(anchor, replacement)
  end

  # -------------------------------------------------------------------------
  # Schemes / workspace / markers
  # -------------------------------------------------------------------------
  def write_schemes!
    FileUtils.mkdir_p(QA_SCHEMES_DIR)
    SCHEME_FILES.each do |scheme|
      source = File.read(File.join(ORIGINAL_SCHEMES_DIR, scheme))
      fail!("#{scheme} does not reference the original project container") unless source.include?(ORIGINAL_PROJECT_CONTAINER)

      contents = source.gsub(ORIGINAL_PROJECT_CONTAINER, QA_PROJECT_CONTAINER)
      fail!("#{scheme} still references the original project after rewrite") if contents.include?(ORIGINAL_PROJECT_CONTAINER)
      # Pods reference (only in "Make Note") must stay untouched.
      if source.include?(PODS_CONTAINER) && !contents.include?(PODS_CONTAINER)
        fail!("#{scheme} lost its Pods reference")
      end

      write_file!(File.join(QA_SCHEMES_DIR, scheme), contents)
    end
  end

  def write_workspace!
    write_file!(File.join(QA_WORKSPACE, "contents.xcworkspacedata"), QA_WORKSPACE_CONTENTS)
  end

  # -------------------------------------------------------------------------
  # Verification of everything we generated
  # -------------------------------------------------------------------------
  def verify!
    verify_project!
    verify_plists!
    verify_entitlements!
    verify_metro_overlay!
    verify_constants_copy!
    verify_schemes!
    verify_workspace!
    verify_markers!
  end

  def verify_project!
    project = Xcodeproj::Project.open(QA_PROJECT)

    fail!("generated project root changed") unless project.root_object.project_dir_path.to_s.empty? && project.root_object.project_root.to_s.empty?
    fail!("generated project has a different target count") unless project.targets.length == Xcodeproj::Project.open(ORIGINAL_PROJECT).targets.length

    project.build_configurations.each do |config|
      config.build_settings.keys.each do |key|
        fail!("project-level signing conditional #{key} still present") if key =~ SIGNING_KEY_PATTERN
      end
    end

    TARGET_SPECS.each do |spec|
      target = project.targets.find { |t| t.name == spec[:target_name] }
      fail!("generated project lost target #{spec[:target_name]}") unless target
      names = target.build_configurations.map(&:name).sort
      fail!("#{spec[:target_name]} configs #{names.inspect}") unless names == %w[Debug Release]

      allowed = qa_signing_keys(spec)
      target.build_configurations.each do |config|
        settings = config.build_settings
        allowed.each do |key, value|
          actual = settings[key]
          fail!("#{spec[:target_name]} #{config.name}: #{key}=#{actual.inspect}, expected #{value.inspect}") unless actual == value
        end
        settings.keys.each do |key|
          next unless key =~ SIGNING_KEY_PATTERN

          fail!("#{spec[:target_name]} #{config.name}: unexpected signing key #{key}") unless allowed.key?(key)
        end
        fail!("#{spec[:target_name]} #{config.name}: BUNDLE_CONFIG must not be set") if !spec[:metro_overlay] && settings.key?("BUNDLE_CONFIG")
      end
    end
  end

  def verify_plists!
    TARGET_SPECS.each do |spec|
      path = File.join(QA_PLISTS_DIR, spec[:info_output])
      fail!("missing generated plist #{rel(path)}") unless File.file?(path)
      plist = Xcodeproj::Plist.read_from_path(path)
      fail!("#{rel(path)} is not a dictionary") unless plist.is_a?(Hash)

      FORBIDDEN_PLIST_KEYS.each do |key|
        fail!("#{rel(path)} still contains #{key}") if plist.key?(key)
      end
      fail!("#{rel(path)} display name #{plist["CFBundleDisplayName"].inspect}") unless plist["CFBundleDisplayName"] == spec[:display_name]

      serialized = File.read(path)
      PRODUCTION_BUNDLE_IDS.each do |bundle_id|
        fail!("#{rel(path)} references production bundle id #{bundle_id}") if serialized.include?(bundle_id)
      end
      fail!("#{rel(path)} references the production App Group") if serialized.include?(PRODUCTION_APP_GROUP)
    end
  end

  def verify_entitlements!
    TARGET_SPECS.each do |spec|
      [spec[:entitlements_ios], spec[:entitlements_macos]].each do |file|
        path = File.join(QA_ENTITLEMENTS_DIR, file)
        fail!("missing generated entitlement #{rel(path)}") unless File.file?(path)
        plist = Xcodeproj::Plist.read_from_path(path)
        fail!("#{rel(path)} is not a dictionary") unless plist.is_a?(Hash)

        fail!("#{rel(path)} declares App Groups") if plist.key?("com.apple.security.application-groups")
        fail!("#{rel(path)} declares time-sensitive notifications") if plist.key?("com.apple.developer.usernotifications.time-sensitive")
        fail!("#{rel(path)} hardcodes an application-identifier") if plist.key?("application-identifier")
        fail!("#{rel(path)} keychain group #{plist["keychain-access-groups"].inspect}") unless plist["keychain-access-groups"] == [QA_KEYCHAIN_GROUP]
      end
      # macOS variants must be sandboxed; iOS variants must not carry sandbox.
      macos = Xcodeproj::Plist.read_from_path(File.join(QA_ENTITLEMENTS_DIR, spec[:entitlements_macos]))
      fail!("#{spec[:entitlements_macos]} is not sandboxed") unless macos["com.apple.security.app-sandbox"] == true
      ios = Xcodeproj::Plist.read_from_path(File.join(QA_ENTITLEMENTS_DIR, spec[:entitlements_ios]))
      fail!("#{spec[:entitlements_ios]} must not declare a macOS sandbox") if ios.key?("com.apple.security.app-sandbox")
    end
  end

  def verify_metro_overlay!
    fail!("missing generated Metro overlay") unless File.file?(QA_METRO_CONFIG)
    contents = File.read(QA_METRO_CONFIG)
    fail!("Metro overlay does not load the original config") unless contents.include?('require("../../metro.config.js")')
    fail!("Metro overlay does not delegate to the original resolver") unless contents.include?("delegateResolveRequest")
    fail!("Metro overlay does not substitute the generated constants copy") unless contents.include?("constants.qa.ts")
    fail!("Metro overlay does not compare fs.realpathSync of the canonical constants") unless contents.include?("fs.realpathSync(CANONICAL_CONSTANTS)")
    fail!("Metro overlay does not compare the resolved realpath to the canonical one") unless contents.include?("canonicalConstantsReal")
    fail!("Metro overlay does not fail closed on an alternative constants module") unless contents.include?("alternative")
    fail!("Metro overlay documents the Release-only supported run") unless contents.include?("Release embedded bundle only")
  end

  def verify_constants_copy!
    fail!("missing generated constants copy") unless File.file?(QA_CONSTANTS)
    contents = File.read(QA_CONSTANTS)
    fail!("generated constants copy has no QA keychain group") unless contents.include?(QA_KEYCHAIN_GROUP)
    fail!("generated constants copy does not import getBundleId") unless contents.include?("getBundleId")
    fail!("generated constants copy still returns the production App Group") if contents.include?(CONSTANTS_KEYCHAIN_FUNCTION_ANCHOR)
    %w[com.ozel0t.veyran.redesignqa20261012 com.ozel0t.veyran.redesignqa20261012.share].each do |bundle_id|
      fail!("generated constants copy missing QA bundle id #{bundle_id}") unless contents.include?(bundle_id)
    end
  end

  def verify_schemes!
    SCHEME_FILES.each do |scheme|
      path = File.join(QA_SCHEMES_DIR, scheme)
      fail!("missing generated scheme #{scheme}") unless File.file?(path)
      contents = File.read(path)
      fail!("#{scheme} references the original project") if contents.include?(ORIGINAL_PROJECT_CONTAINER)
      fail!("#{scheme} does not reference the generated project") unless contents.include?(QA_PROJECT_CONTAINER)
      # Only the generated project and Pods may be referenced.
      contents.scan(/ReferencedContainer = "([^"]+)"/).flatten.each do |container|
        next if [QA_PROJECT_CONTAINER, PODS_CONTAINER].include?(container)

        fail!("#{scheme} references unexpected container #{container}")
      end
    end
  end

  def verify_workspace!
    path = File.join(QA_WORKSPACE, "contents.xcworkspacedata")
    fail!("missing generated workspace") unless File.file?(path)
    contents = File.read(path)
    fail!("generated workspace references the original project") if contents.include?("Notesnook.xcodeproj")
    fail!("generated workspace lacks the QA project") unless contents.include?("group:VeyraNRedesignQA.xcodeproj")
    fail!("generated workspace lacks the Pods project") unless contents.include?("group:Pods/Pods.xcodeproj")
  end

  def verify_markers!
    [QA_DIR, QA_PROJECT, QA_WORKSPACE].each do |dir|
      marker = File.join(dir, OWNER_MARKER_FILE)
      fail!("missing ownership marker in #{rel(dir)}") unless File.file?(marker)
      fail!("ownership marker body changed in #{rel(dir)}") unless File.read(marker) == OWNER_MARKER_BODY
    end
  end

  # Hashes generated artifacts that are not covered by the QA_DIR glob: the
  # generated pbxproj, the ownership markers of the project/workspace dirs and
  # (re)records the workspace file so a rerun can be diffed exactly.
  def record_extra_output_hashes!
    project_pbxproj = File.join(QA_PROJECT, "project.pbxproj")
    fail!("generated project.pbxproj is missing") unless File.file?(project_pbxproj)
    @output_hashes[rel(project_pbxproj)] = hash_file(project_pbxproj)

    [QA_PROJECT, QA_WORKSPACE].each do |dir|
      marker = File.join(dir, OWNER_MARKER_FILE)
      fail!("missing ownership marker in #{rel(dir)}") unless File.file?(marker)
      @output_hashes[rel(marker)] = hash_file(marker)
    end

    workspace_data = File.join(QA_WORKSPACE, "contents.xcworkspacedata")
    fail!("generated workspace is missing") unless File.file?(workspace_data)
    @output_hashes[rel(workspace_data)] = hash_file(workspace_data)
  end

  def write_receipt!
    record_extra_output_hashes!

    # Hash every remaining generated file so the coordinator can diff a rerun.
    Dir.glob(File.join(QA_DIR, "**", "*")).sort.each do |path|
      next unless File.file?(path)

      @output_hashes[rel(path)] = hash_file(path)
    end

    receipt = {
      "generator" => "apps/mobile/scripts/generate-redesign-qa.rb",
      "generated_at" => Time.now.utc.iso8601,
      "qa_identity" => {
        "team_id" => QA_TEAM_ID,
        "host_bundle_id" => QA_HOST_BUNDLE_ID,
        "share_bundle_id" => QA_SHARE_BUNDLE_ID,
        "widget_bundle_id" => QA_WIDGET_BUNDLE_ID,
        "keychain_access_group" => QA_KEYCHAIN_GROUP,
        "app_groups" => [],
        "code_sign_style" => "Automatic",
        "code_sign_identity_fingerprint" => QA_CERT_FINGERPRINT,
        "manual_provisioning_profile_settings" => false,
        # Verification expectations only: the coordinator checks these against
        # the ACTUAL signed artifacts. They are intentionally NOT written as
        # PROVISIONING_PROFILE(_SPECIFIER) build settings, because the local
        # Catalyst profile is Xcode-managed.
        "expected_provisioning_profile_uuid" => QA_PROFILE_UUID,
        "expected_provisioning_profile_name" => QA_PROFILE_NAME
      },
      "sources_sha256" => @source_hashes.sort.to_h,
      "outputs_sha256" => @output_hashes.sort.to_h,
      "notes" => [
        "Generated from the current on-disk dirty tree; no HEAD copy was used.",
        "QA is groupless: native Share attachment / widget / alarm App Group workflows are UNVERIFIED.",
        "Signing is CODE_SIGN_STYLE=Automatic with the existing team/certificate; no manual PROVISIONING_PROFILE(_SPECIFIER) is forced. Build WITHOUT -allowProvisioningUpdates; if the local profile cannot resolve, report the concrete blocker instead of creating a profile or fetching assets.",
        "SUPPORTED QA RUN: Release embedded bundle only. A QA Debug build uses the RN dev server and is UNVERIFIED/unsupported unless separately configured with the generated QA Metro overlay; the original native JS bundle URL is untouched.",
        "The expected provisioning profile UUID/name above are verification expectations for the coordinator to compare against actual signed artifacts, not build settings.",
        "BUNDLE_CONFIG (Metro overlay) is set on the host and share targets only; the overlay fails closed if the resolver returns an alternative app/utils/constants.ts.",
        "Production bundle id #{PRODUCTION_APP_GROUP} and #{PRODUCTION_BUNDLE_IDS.join(", ")} are intentionally absent from QA outputs."
      ]
    }
    assert_inside_root!(QA_RECEIPT)
    assert_no_symlinks!(QA_RECEIPT)
    File.write(QA_RECEIPT, JSON.pretty_generate(receipt) + "\n")
    @output_hashes[rel(QA_RECEIPT)] = hash_file(QA_RECEIPT)
  end
end

Generator.new.run
