import java.util.Properties
import groovy.json.JsonSlurper

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

android {
    compileSdk = 36
    namespace = "com.rclone.manager"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        applicationId = "com.rclone.manager"
        minSdk = 24
        targetSdk = 36
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
    }
    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            isMinifyEnabled = true
            proguardFiles(
                *fileTree(".") { include("**/*.pro") }
                    .plus(getDefaultProguardFile("proguard-android-optimize.txt"))
                    .toList().toTypedArray()
            )
        }
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }
    buildFeatures {
        buildConfig = true
    }
}

rust {
    rootDirRel = "../../../"
}

// Resolve the Kotlin verifier from the same crate version selected by Cargo.
val rustlsAndroidPackage = providers.exec {
    workingDir(rootProject.projectDir)
    commandLine("cargo", "metadata", "--locked", "--format-version", "1",
        "--filter-platform", "aarch64-linux-android", "--manifest-path",
        rootProject.file("../../../Cargo.toml").absolutePath)
}.standardOutput.asText.map { output ->
    val metadata = JsonSlurper().parseText(output) as Map<*, *>
    (metadata["packages"] as List<*>).map { it as Map<*, *> }
        .first { it["name"] == "rustls-platform-verifier-android" }
}

repositories {
    maven {
        url = uri(File(rustlsAndroidPackage.get()["manifest_path"] as String).parentFile.resolve("maven"))
        metadataSources { mavenPom(); artifact() }
    }
}

dependencies {
    implementation("rustls:rustls-platform-verifier:${rustlsAndroidPackage.get()["version"]}")
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = "tauri.build.gradle.kts")

// Backport https://github.com/tauri-apps/wry/pull/1865 while Tauri uses Wry 0.55.
// Run AFTER Rust generates the client and BEFORE Kotlin consumes it. Patching
// the Cargo registry or editing the generated file manually would not survive rebuilds.
afterEvaluate {
    tasks.matching { it.name.startsWith("compile") && it.name.endsWith("Kotlin") }
        .toList().forEach { compileTask ->
            val variant = compileTask.name.removePrefix("compile").removeSuffix("Kotlin")
            val rustTask = tasks.findByName("rustBuild$variant")
            if (rustTask != null) {
                val patchTask = tasks.register("patch${variant}MediaRanges") {
                    dependsOn(rustTask)
                    doLast {
                        val client = file("src/main/java/com/rclone/manager/generated/RustWebViewClient.kt")
                        val source = client.readText()
                        val hook = "com.rclone.manager.MediaRangeResponse.wrap(request, response)"
                        // Avoid double wrapping once the upstream fix is included.
                        if (!source.contains(hook) && !source.contains("wrapPartialContentBody(request, response)")) {
                            val anchor = "interceptedState[request.url.toString()] = response != null"
                            check(source.split(anchor).size == 2) {
                                "Wry interception changed; review the Android media range backport"
                            }
                            client.writeText(source.replace(anchor, "$hook\n            $anchor"))
                        }
                    }
                }
                compileTask.dependsOn(patchTask)
            }
        }
}
