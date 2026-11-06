plugins {
    id("com.android.application")
}

android {
    namespace = "io.github.fanqin314.kcb"
    compileSdk = 34

    defaultConfig {
        applicationId = "io.github.fanqin314.kcb"
        minSdk = 24
        targetSdk = 34
        versionCode = 1
        versionName = "1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}
