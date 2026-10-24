package com.rclone.manager

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RcloneAppUpdaterTest {
  private val installed = UpdatePackageIdentity("com.rclone.manager", 10, setOf("publisher"))

  @Test fun acceptsOnlyNewerVersionsOfTheSameSignedPackage() {
    assertTrue(validUpdatePackage(installed, installed.copy(versionCode = 11)))
    assertFalse(validUpdatePackage(installed, installed))
    assertFalse(validUpdatePackage(installed, installed.copy(versionCode = 9)))
    assertFalse(validUpdatePackage(installed, installed.copy(versionCode = 11, packageName = "other.app")))
    assertFalse(validUpdatePackage(installed, installed.copy(versionCode = 11, signers = setOf("other"))))
    assertFalse(validUpdatePackage(installed.copy(signers = emptySet()), installed.copy(versionCode = 11, signers = emptySet())))
  }
}
